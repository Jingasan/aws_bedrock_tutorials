import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Agent } from "@mastra/core/agent";
import type { ModelMessage } from "ai";

const AWS_PROFILE = process.env.AWS_PROFILE ?? "default";
// bedrock-runtime エンドポイントは東京 (ap-northeast-1) からグローバルルーティングの
// Claude Sonnet 5 を利用できるため東京をデフォルトにする (03 と同じ)。
const AWS_REGION = process.env.AWS_REGION ?? "ap-northeast-1";
// global.anthropic.claude-sonnet-5 はグローバルクロスリージョン推論プロファイル
// (基本料金・最高可用性)。東京は In-Region (anthropic.claude-sonnet-5 単体) と
// jp Geo ルーティングが未提供のため global プレフィックスが必須。
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-sonnet-5";

// 03 では streamText の system に渡していたシステムプロンプト。
// Mastra ではエージェント定義の instructions として宣言する。
const SYSTEM_PROMPT =
  "あなたは親切なアシスタントです。ユーザーの質問に日本語で分かりやすく回答してください。";

// AI SDK の Bedrock Anthropic プロバイダー。bedrock-runtime の InvokeModel /
// InvokeModelWithResponseStream を Anthropic Messages API ネイティブ形式で呼び出す。
// SigV4 署名は SDK が自動で行い、認証情報は AWS SDK の標準チェーン
// (fromNodeProviderChain) からプロファイル指定で解決する。
const bedrockAnthropic = createAmazonBedrockAnthropic({
  region: AWS_REGION,
  credentialProvider: fromNodeProviderChain({ profile: AWS_PROFILE }),
});

// Mastra のエージェント定義。Mastra は AI SDK プロバイダーのモデルインスタンスを
// そのまま model に受け付けるため、モデル呼び出し部分は 03 と完全に共通化できる。
// 03 の streamText 呼び出しごとの system 指定と違い、システムプロンプト (instructions)
// やモデルはエージェントという再利用可能な単位に束ねられる (ツールやメモリも同様に
// ここへ追加していくのが Mastra の流儀だが、本チュートリアルではスコープ外)。
const chatAgent = new Agent({
  // エージェントの一意識別子 (Mastra インスタンスへ登録する際のキーにも使われる)
  id: "bedrock-chat-agent",
  // エージェントの表示名
  name: "bedrock-chat-agent",
  // エージェントの役割定義 (Anthropic Messages API の system プロンプトに相当)
  instructions: SYSTEM_PROMPT,
  // AI SDK のモデルインスタンス
  model: bedrockAnthropic(MODEL_ID),
});

/**
 * agent.stream のストリーミングで応答を表示し、完成した回答テキストを返す。
 *
 * @param messages これまでの会話履歴
 * @returns 完成した回答テキスト
 */
async function streamReply(messages: ModelMessage[]): Promise<string> {
  const stream = await chatAgent.stream(messages, {
    // AI SDK のモデル呼び出し設定 (03 で streamText に直接渡していたものに相当)
    modelSettings: {
      // 応答の最大出力トークン数
      maxOutputTokens: 4096,
    },
  });

  // textStream はテキスト差分のみを流し、レート制限等のエラーをエラーチャンクとして
  // 扱い throw せずに終了する。エラー検知とトークン使用量の取得を 1 つのループで
  // 行うため、全イベントが流れる fullStream をチャンク種別で振り分けて消費する。
  let reply = "";
  let streamError: unknown;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  for await (const chunk of stream.fullStream) {
    switch (chunk.type) {
      // テキスト差分 (reasoning などその他のパートは対象外)
      case "text-delta":
        reply += chunk.payload.text;
        stdout.write(chunk.payload.text);
        break;
      // ストリーム内エラー (ループ後に throw して呼び出し元の catch に届ける)
      case "error":
        streamError = chunk.payload.error;
        break;
      // ストリーム完了 (トークン使用量はこのチャンクで確定する)
      case "finish":
        usage = chunk.payload.output.usage;
        break;
    }
    // エラー後に後続チャンクが流れ続ける実装でも不要な出力をしないよう即座に打ち切る
    if (streamError !== undefined) {
      break;
    }
  }
  if (streamError !== undefined) {
    throw streamError instanceof Error
      ? streamError
      : new Error(String(streamError));
  }

  stdout.write(
    `\n  (入力 ${usage?.inputTokens ?? "不明"} / 出力 ${usage?.outputTokens ?? "不明"} トークン)\n`,
  );
  return reply;
}

/**
 * 対話ループ本体。会話履歴を保持し、文脈を踏まえた連続質問を可能にする。
 */
async function main(): Promise<void> {
  console.log(`モデル: ${MODEL_ID}`);
  console.log(`リージョン: ${AWS_REGION} / プロファイル: ${AWS_PROFILE}`);
  console.log('質問を入力してください。"exit" または Ctrl+D で終了します。\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const messages: ModelMessage[] = [];

  // Ctrl+D などで入力が閉じられても rl.question() の Promise は解決も拒否もされないため、
  // close イベントを別 Promise で監視し、race で終了を検知する
  let inputClosed = false;
  const closed = new Promise<null>((resolve) => {
    rl.once("close", () => {
      inputClosed = true;
      resolve(null);
    });
  });

  while (true) {
    // 応答ストリーミング中に入力が閉じられた場合、close 済みの readline に
    // question() を呼ぶと ERR_USE_AFTER_CLOSE で落ちるため先にチェックする
    if (inputClosed) {
      break;
    }
    const answer = await Promise.race([rl.question("あなた> "), closed]);
    if (answer === null) {
      // Ctrl+D などで入力が閉じられた場合
      break;
    }
    const question = answer.trim();

    if (question === "") {
      continue;
    }
    if (question === "exit" || question === "quit") {
      break;
    }

    messages.push({ role: "user", content: question });
    stdout.write("\nClaude> ");

    try {
      const reply = await streamReply(messages);
      messages.push({ role: "assistant", content: reply });
      stdout.write("\n");
    } catch (error) {
      // 失敗したターンは履歴から取り除き、会話を続行できるようにする
      messages.pop();
      console.error(
        `\nエラーが発生しました: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  rl.close();
  console.log("\n終了します。");
}

await main();
