import readline from "node:readline/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createAmazonBedrockAnthropic } from "@ai-sdk/amazon-bedrock/anthropic";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";

//============================================================
// 設定値
// 接続先・モデル・会話スレッドの識別子を環境変数で上書き可能にする。
//============================================================

const AWS_PROFILE = process.env.AWS_PROFILE ?? "default";
// bedrock-runtime エンドポイントは東京 (ap-northeast-1) からグローバルルーティングの
// Claude Sonnet 5 を利用できるため東京をデフォルトにする (03/04 と同じ)。
const AWS_REGION = process.env.AWS_REGION ?? "ap-northeast-1";
// global.anthropic.claude-sonnet-5 はグローバルクロスリージョン推論プロファイル
// (基本料金・最高可用性)。東京は In-Region (anthropic.claude-sonnet-5 単体) と
// jp Geo ルーティングが未提供のため global プレフィックスが必須。
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-sonnet-5";

// Memory は「resource (ユーザー) が所有する thread (会話)」単位で履歴を保存する。
// 固定のデフォルト値にすることで、プロセスを再起動しても同じ会話の続きから再開できる。
// 別の会話を始めたい場合は MEMORY_THREAD_ID を変える (thread は resource に紐づくため、
// resource を変える場合は thread もペアで変えること。別 resource から既存 thread は開けない)。
const THREAD_ID = process.env.MEMORY_THREAD_ID ?? "tutorial-thread";
const RESOURCE_ID = process.env.MEMORY_RESOURCE_ID ?? "tutorial-user";

// 会話履歴の保存先 SQLite ファイル。libsql の file: URL は実行時カレントディレクトリ
// 相対で解釈されるため、実行場所に依存しないようこのファイル基準の絶対パスを組み立てる
// (05_mastra_memory_bedrock ディレクトリ直下の memory.db)。
const DB_PATH = path.join(import.meta.dirname, "..", "memory.db");

// 04 と同じシステムプロンプト。Mastra ではエージェント定義の instructions として宣言する。
const SYSTEM_PROMPT =
  "あなたは親切なアシスタントです。ユーザーの質問に日本語で分かりやすく回答してください。";

//============================================================
// Mastra Memory
// 会話履歴を SQLite (libsql) ファイルに永続化し、モデル呼び出し時に直近の履歴を
// 自動でコンテキストへ注入する。04 で手動管理していた ModelMessage[] 配列の
// push/pop はすべて Memory に委譲される。
//============================================================

// エージェントに渡す Memory インスタンス。semantic recall (過去会話の意味検索) と
// working memory はデフォルト無効のため、vector DB や埋め込みモデルの設定は不要。
// スレッドタイトルの自動生成 (generateTitle) もデフォルト無効なので、
// 履歴保存のための追加 LLM 呼び出し (＝追加コスト) は発生しない。
const memory = new Memory({
  // 履歴の保存先ストレージ (libsql)。url を ":memory:" にするとセッション内のみ保持になる
  storage: new LibSQLStore({
    // ストレージの識別子
    id: "chat-memory-storage",
    // 保存先 SQLite ファイル (file: + 絶対パス)
    url: `file:${DB_PATH}`,
  }),
  options: {
    // モデルへ注入する直近メッセージ件数 (デフォルト 10 / false で注入無効)。
    // 増やすほど長い文脈を保てる代わりに毎ターンの入力トークンが増える。
    lastMessages: 10,
  },
});

//============================================================
// Bedrock プロバイダーとエージェント定義
// モデル呼び出し部分は 03/04 と共通。04 との差分は memory の追加のみ。
//============================================================

// AI SDK の Bedrock Anthropic プロバイダー。bedrock-runtime の InvokeModel /
// InvokeModelWithResponseStream を Anthropic Messages API ネイティブ形式で呼び出す。
// SigV4 署名は SDK が自動で行い、認証情報は AWS SDK の標準チェーン
// (fromNodeProviderChain) からプロファイル指定で解決する。
const bedrockAnthropic = createAmazonBedrockAnthropic({
  region: AWS_REGION,
  credentialProvider: fromNodeProviderChain({ profile: AWS_PROFILE }),
});

// Mastra のエージェント定義。04 のエージェントに memory を追加しただけで、
// モデル・システムプロンプトの束ね方は同一。memory を持つエージェントは
// stream 呼び出し時に thread/resource を指定するだけで履歴の読込・保存を自動で行う。
const chatAgent = new Agent({
  // エージェントの一意識別子 (Mastra インスタンスへ登録する際のキーにも使われる)
  id: "bedrock-memory-chat-agent",
  // エージェントの表示名
  name: "bedrock-memory-chat-agent",
  // エージェントの役割定義 (Anthropic Messages API の system プロンプトに相当)
  instructions: SYSTEM_PROMPT,
  // AI SDK のモデルインスタンス
  model: bedrockAnthropic(MODEL_ID),
  // 会話履歴の永続化 (上記 Memory インスタンス)
  memory,
});

//============================================================
// 対話ループ
// 04 と違い stream には新しい質問文字列だけを渡す。過去の履歴は Memory が
// lastMessages 件だけ自動でコンテキストに注入するため、履歴配列を渡してはならない
// (渡すと履歴の二重注入・二重保存になる)。
//============================================================

/**
 * agent.stream のストリーミングで応答を表示する。
 *
 * @param question 新しい質問文 (履歴は Memory が自動注入するため渡さない)
 */
async function streamReply(question: string): Promise<void> {
  const stream = await chatAgent.stream(question, {
    // 履歴の保存・注入先となる会話スレッドの指定。
    // resource を省略すると保存が黙ってスキップされるため、必ず thread とペアで渡す。
    memory: {
      thread: THREAD_ID,
      resource: RESOURCE_ID,
    },
    // AI SDK のモデル呼び出し設定 (03/04 と同じ)
    modelSettings: {
      // 応答の最大出力トークン数
      maxOutputTokens: 4096,
    },
  });

  // textStream はテキスト差分のみを流し、レート制限等のエラーをエラーチャンクとして
  // 扱い throw せずに終了する。エラー検知とトークン使用量の取得を 1 つのループで
  // 行うため、全イベントが流れる fullStream をチャンク種別で振り分けて消費する。
  let streamError: unknown;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  for await (const chunk of stream.fullStream) {
    switch (chunk.type) {
      // テキスト差分 (reasoning などその他のパートは対象外)
      case "text-delta":
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
}

/**
 * 起動時に会話スレッドの状態を表示する。既存スレッドがあれば「前回の続き」である
 * ことと累計メッセージ件数を示し、Memory の永続化が効いていることを可視化する。
 */
async function printThreadStatus(): Promise<void> {
  // スレッドは初回ターンの正常完了時に Mastra が自動作成するため、初回起動時は null。
  // resourceId も渡して所有者チェックを行い、resource だけ変えた誤設定 (所有者不一致) を
  // ストリーム実行前のこの時点で「新規スレッド」として検知できるようにする
  const thread = await memory.getThreadById({
    threadId: THREAD_ID,
    resourceId: RESOURCE_ID,
  });
  if (thread === null) {
    console.log(`新規スレッド "${THREAD_ID}" を開始します。`);
    return;
  }
  // perPage: 1 で本文の取得を最小限にしつつ、total (スレッド内の累計メッセージ数) を得る
  const { total } = await memory.recall({
    threadId: THREAD_ID,
    resourceId: RESOURCE_ID,
    perPage: 1,
  });
  console.log(
    `既存スレッド "${THREAD_ID}" を再開します (これまでのメッセージ: ${total} 件)。`,
  );
}

/**
 * 対話ループ本体。会話履歴は Memory が memory.db に永続化するため、
 * プロセスを再起動しても同じスレッドの文脈を踏まえた連続質問ができる。
 */
async function main(): Promise<void> {
  console.log(`モデル: ${MODEL_ID}`);
  console.log(`リージョン: ${AWS_REGION} / プロファイル: ${AWS_PROFILE}`);
  console.log(`履歴 DB: ${DB_PATH}`);
  await printThreadStatus();
  console.log('質問を入力してください。"exit" または Ctrl+D で終了します。\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });

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

    stdout.write("\nClaude> ");

    try {
      await streamReply(question);
      stdout.write("\n");
    } catch (error) {
      // Memory への保存はストリームの正常完了時のみ行われ、エラーで終わったターンは
      // ユーザーメッセージも含めて永続化されない (現行 @mastra/core 1.61 の挙動)。
      // そのため 04 のような履歴のロールバック (messages.pop) は不要で、表示だけ行う。
      console.error(
        `\nエラーが発生しました: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  rl.close();
  console.log("\n終了します。");
}

await main();
