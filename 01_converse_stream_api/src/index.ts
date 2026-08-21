import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";

const AWS_PROFILE = process.env.AWS_PROFILE ?? "default";
const AWS_REGION = process.env.AWS_REGION ?? "ap-northeast-1";
// terraform output -raw inference_profile_arn の値を渡すと
// アプリケーション推論プロファイル経由 (コスト配分タグ付き) で呼び出せる。
// 未指定時はシステム定義の日本国内クロスリージョン推論プロファイルを使う。
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "jp.anthropic.claude-sonnet-4-6";

const SYSTEM_PROMPT =
  "あなたは親切なアシスタントです。ユーザーの質問に日本語で分かりやすく回答してください。";

const client = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: fromIni({ profile: AWS_PROFILE }),
});

// ConverseStream API で応答をストリーミング表示し、完成した回答テキストを返す
async function streamReply(messages: Message[]): Promise<string> {
  const response = await client.send(
    new ConverseStreamCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      inferenceConfig: {
        maxTokens: 4096,
      },
    }),
  );

  let reply = "";
  for await (const event of response.stream ?? []) {
    const text = event.contentBlockDelta?.delta?.text;
    if (text !== undefined) {
      reply += text;
      stdout.write(text);
    }

    const usage = event.metadata?.usage;
    if (usage !== undefined) {
      stdout.write(
        `\n  (入力 ${usage.inputTokens} / 出力 ${usage.outputTokens} トークン)\n`,
      );
    }
  }
  return reply;
}

async function main(): Promise<void> {
  console.log(`モデル: ${MODEL_ID}`);
  console.log(`リージョン: ${AWS_REGION} / プロファイル: ${AWS_PROFILE}`);
  console.log('質問を入力してください。"exit" または Ctrl+D で終了します。\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const messages: Message[] = [];

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

    messages.push({ role: "user", content: [{ text: question }] });
    stdout.write("\nClaude> ");

    try {
      const reply = await streamReply(messages);
      messages.push({ role: "assistant", content: [{ text: reply }] });
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
