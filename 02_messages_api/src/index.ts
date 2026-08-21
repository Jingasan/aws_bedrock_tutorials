import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

const AWS_PROFILE = process.env.AWS_PROFILE ?? "default";
// bedrock-mantle はリージョンごとに独自のモデルカタログを持ち、東京 (ap-northeast-1) の
// エンドポイントは Claude Sonnet 5 を未提供 (404) のため us-east-1 をデフォルトにする。
// モデルはグローバルルーティングのため、推論の実行リージョンはエンドポイントに固定されない。
// 東京 mantle が Sonnet 5 の提供を開始したら AWS_REGION=ap-northeast-1 で切り替え可能。
const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
// Claude 5 系は Messages API ベースの新しい Bedrock エンドポイント (bedrock-mantle) 経由で提供される。
// anthropic.claude-sonnet-5 はグローバルルーティング (プレミアムなしの基本料金・最高可用性)。
// データレジデンシー要件がある場合は jp.anthropic.claude-sonnet-5 (日本国内ルーティング、
// グローバル比 10% プレミアム) を BEDROCK_MODEL_ID で指定する。
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-sonnet-5";

const SYSTEM_PROMPT =
  "あなたは親切なアシスタントです。ユーザーの質問に日本語で分かりやすく回答してください。";

// bedrock-mantle エンドポイント (https://bedrock-mantle.{region}.api.aws/anthropic) 用クライアント。
// SigV4 署名と anthropic-version ヘッダーの付与は SDK が自動で行う。
const client = new AnthropicBedrockMantle({
  awsRegion: AWS_REGION,
  awsProfile: AWS_PROFILE,
});

/**
 * Messages API のストリーミングで応答を表示し、完成した回答テキストを返す。
 *
 * @param messages これまでの会話履歴
 * @returns 完成した回答テキスト
 */
async function streamReply(messages: MessageParam[]): Promise<string> {
  const stream = client.messages.stream({
    model: MODEL_ID,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages,
  });

  let reply = "";
  for await (const event of stream) {
    // テキスト差分のみ表示する (thinking などその他のコンテンツブロックは対象外)
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      reply += event.delta.text;
      stdout.write(event.delta.text);
    }
  }

  // ストリーム完了後の最終メッセージからトークン使用量を表示する
  const finalMessage = await stream.finalMessage();
  stdout.write(
    `\n  (入力 ${finalMessage.usage.input_tokens} / 出力 ${finalMessage.usage.output_tokens} トークン)\n`,
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
  const messages: MessageParam[] = [];

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
