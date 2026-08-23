import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { streamText, type ModelMessage } from "ai";

const AWS_PROFILE = process.env.AWS_PROFILE ?? "default";
// bedrock-runtime エンドポイントは東京 (ap-northeast-1) からグローバルルーティングの
// Claude Sonnet 5 を利用できるため、02 (bedrock-mantle・東京未提供) と異なり東京をデフォルトにする。
const AWS_REGION = process.env.AWS_REGION ?? "ap-northeast-1";
// global.anthropic.claude-sonnet-5 はグローバルクロスリージョン推論プロファイル
// (基本料金・最高可用性)。東京は In-Region (anthropic.claude-sonnet-5 単体) と
// jp Geo ルーティングが未提供のため global プレフィックスが必須。
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-sonnet-5";

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

/**
 * streamText のストリーミングで応答を表示し、完成した回答テキストを返す。
 *
 * @param messages これまでの会話履歴
 * @returns 完成した回答テキスト
 */
async function streamReply(messages: ModelMessage[]): Promise<string> {
  // streamText の textStream はストリーム内エラー (レート制限等) をエラーパートとして
  // 扱い throw せずに終了するため、onError で捕捉してループ後に throw し、
  // 呼び出し元の catch に届ける (ネットワーク断などの致命的エラーのみ for-await から throw される)
  let streamError: unknown;
  const result = streamText({
    model: bedrockAnthropic(MODEL_ID),
    maxOutputTokens: 4096,
    system: SYSTEM_PROMPT,
    messages,
    onError({ error }) {
      streamError = error;
    },
  });

  // textStream はテキスト差分のみを流す (reasoning などその他のパートは対象外)
  let reply = "";
  for await (const text of result.textStream) {
    reply += text;
    stdout.write(text);
  }
  if (streamError !== undefined) {
    throw streamError instanceof Error
      ? streamError
      : new Error(String(streamError));
  }

  // ストリーム完了後にトークン使用量を表示する (使用量はストリーム完了時に確定する)
  const usage = await result.usage;
  stdout.write(
    `\n  (入力 ${usage.inputTokens ?? "不明"} / 出力 ${usage.outputTokens ?? "不明"} トークン)\n`,
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
