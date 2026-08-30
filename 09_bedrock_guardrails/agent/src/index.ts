import readline from "node:readline/promises";
import path from "node:path";
import { stdin, stdout } from "node:process";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { GroundingSourceProcessor } from "./grounding-processor.ts";
import { extractGuardrailTrace, formatGuardrailTrace } from "./guardrail-trace.ts";

//============================================================
// 設定値
// 接続先・モデル・Guardrail・会話スレッドの識別子を環境変数で指定する。
//============================================================

const AWS_PROFILE = process.env.AWS_PROFILE ?? "default";
// Guardrail は terraform/ で作成したリージョンからしか参照できないため、terraform の aws_region と一致させる
const AWS_REGION = process.env.AWS_REGION ?? "ap-northeast-1";
// Guardrails は Converse API 経由で任意の対応モデルに適用できる。デフォルトは東京 In-Region の Nova Lite
// (terraform output model_id と同じ値)。05 と同じ Claude を使う場合は global.anthropic.claude-sonnet-5 を指定する。
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "amazon.nova-lite-v1:0";

// terraform output guardrail_id / guardrail_version の値。Guardrail 無しでは本チュートリアルの意味が無いため必須にする
const GUARDRAIL_ID = requireEnv("BEDROCK_GUARDRAIL_ID");
const GUARDRAIL_VERSION = requireEnv("BEDROCK_GUARDRAIL_VERSION");

// Contextual grounding の根拠テキスト付与を切る場合は "off" を指定する (雑談など FAQ 外の会話を試すとき用。
// grounding は「応答が根拠に基づくか」を見るため、FAQ 外の話題は正しい応答でもブロックされ得る)
const GROUNDING_CHECK_ENABLED = (process.env.GROUNDING_CHECK ?? "on") !== "off";

// Memory は「resource (ユーザー) が所有する thread (会話)」単位で履歴を保存する (05 と同じ)
const THREAD_ID = process.env.MEMORY_THREAD_ID ?? "tutorial-thread";
const RESOURCE_ID = process.env.MEMORY_RESOURCE_ID ?? "tutorial-user";

// 会話履歴の保存先 SQLite ファイル (agent ディレクトリ直下の memory.db)
const DB_PATH = path.join(import.meta.dirname, "..", "memory.db");

/**
 * 必須の環境変数を取得する。未設定なら起動を中止する。
 *
 * @param name 環境変数名
 * @returns 環境変数の値
 */
/**
 * Converse API の guardrailConfig。AI SDK は providerOptions.bedrock 配下を型検査せずそのままリクエストに載せるため、
 * キー名のタイポを typecheck で検知できるようここで形を固定して satisfies で照合する。
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailStreamConfiguration.html
 */
interface BedrockGuardrailConfig {
  guardrailIdentifier: string;
  guardrailVersion: string;
  trace: "disabled" | "enabled" | "enabled_full";
  streamProcessingMode: "sync" | "async";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(
      `環境変数 ${name} が未設定です。terraform/ で apply した後、\`terraform output env_command\` の内容を実行してください。`,
    );
    process.exit(1);
  }
  return value;
}

//============================================================
// 根拠テキスト (grounding_source)
// RAG で Knowledge Base から取得した文書に相当する固定テキスト。Contextual grounding は
// 「応答がこのテキストに基づいているか (GROUNDING)」「質問に答えているか (RELEVANCE)」を採点する。
// システムプロンプトにも同じ内容を回答範囲として指示し、モデル側もこの範囲で答えるようにする。
//============================================================

const GROUNDING_SOURCE = `【社内 IT ヘルプデスク FAQ】
Q1. 社内 VPN の接続方法は？
A1. 社内ポータルから VPN クライアントをダウンロードし、社員番号とワンタイムパスワードでログインします。同時接続は 1 台までです。
Q2. パスワードを忘れた場合は？
A2. セルフサービスポータルの「パスワードリセット」から、登録済みの社用スマートフォンで本人確認を行うと再設定できます。ヘルプデスクへの電話は不要です。
Q3. 有給休暇の申請方法は？
A3. 勤怠システムで希望日を選択し「有給休暇」を選んで申請します。上長の承認後に確定します。申請は取得日の 3 営業日前までに行ってください。
Q4. ヘルプデスクの受付時間は？
A4. 平日 9:00〜18:00 です。土日祝日は休業です。
Q5. 業務用 PC の交換サイクルは？
A5. 原則 4 年です。故障時はヘルプデスクへ申請すると代替機を貸与します。`;

const SYSTEM_PROMPT = `あなたは社内 IT ヘルプデスクのアシスタントです。ユーザーメッセージに添付される「社内 IT ヘルプデスク FAQ」の内容だけを根拠に、日本語で簡潔に回答してください。
FAQ に記載のない事項を質問された場合は、推測で答えず「FAQ に記載がないためヘルプデスクへお問い合わせください」と案内してください。`;

//============================================================
// Mastra Memory (05 と同じ構成)
//============================================================

const memory = new Memory({
  storage: new LibSQLStore({
    id: "chat-memory-storage",
    url: `file:${DB_PATH}`,
  }),
  options: {
    // モデルへ注入する直近メッセージ件数
    lastMessages: 10,
  },
});

//============================================================
// Bedrock プロバイダー (Converse API) とエージェント定義
// 05 の @ai-sdk/amazon-bedrock/anthropic (InvokeModel ネイティブ形式) は Guardrails 非対応のため、
// Converse API を使う createAmazonBedrock に切り替える。Guardrail は providerOptions.bedrock.guardrailConfig
// でモデル呼び出しにアタッチし、入力・出力の評価は Bedrock 側で自動的に行われる。
//============================================================

const bedrock = createAmazonBedrock({
  region: AWS_REGION,
  credentialProvider: fromNodeProviderChain({ profile: AWS_PROFILE }),
});

const chatAgent = new Agent({
  id: "bedrock-guardrails-chat-agent",
  name: "bedrock-guardrails-chat-agent",
  instructions: SYSTEM_PROMPT,
  model: bedrock(MODEL_ID),
  memory,
  // 全呼び出しに共通で適用する実行オプション
  defaultOptions: {
    // プロバイダー固有オプション。bedrock キー配下は Converse API のリクエストにそのまま載る
    providerOptions: {
      bedrock: {
        // モデル呼び出しにアタッチする Guardrail (Converse API の guardrailConfig)
        guardrailConfig: {
          // terraform で作成した Guardrail とバージョン
          guardrailIdentifier: GUARDRAIL_ID,
          guardrailVersion: GUARDRAIL_VERSION,
          // 判定内容 (trace) を応答メタデータに含める
          // (disabled: 含めない / enabled: 検出された項目のみ / enabled_full: 未検出項目も含む全項目)
          trace: "enabled",
          // ストリーミング時の評価タイミング
          // (async: 本文を流しながら並行して評価。低遅延だがブロック対象の本文が一部表示され得る /
          //  sync: 評価が終わった単位ごとに本文を流す。遅延は増えるがブロック対象は表示されない)
          streamProcessingMode: "sync",
        } satisfies BedrockGuardrailConfig,
      },
    },
    modelSettings: {
      // 応答の最大出力トークン数
      maxOutputTokens: 1024,
    },
  },
  // Contextual grounding 用の根拠テキストを送信直前のプロンプトに付与する
  inputProcessors: GROUNDING_CHECK_ENABLED ? [new GroundingSourceProcessor(GROUNDING_SOURCE)] : [],
});

//============================================================
// 対話ループ
//============================================================

/**
 * agent.stream のストリーミングで応答を表示し、終了時に Guardrail の判定内容を表示する。
 *
 * Guardrail が介入した場合、Bedrock はモデル応答の代わりに blocked_*_messaging の文言をテキストとして返し、
 * stopReason を guardrail_intervened (AI SDK では finishReason "content-filter") にする。
 * PII のマスク (ANONYMIZE) はテキストが置換された状態で流れてくる。
 *
 * @param question 新しい質問文 (履歴は Memory が自動注入する)
 */
async function streamReply(question: string): Promise<void> {
  const stream = await chatAgent.stream(question, {
    // 履歴の保存・注入先となる会話スレッド (resource を省略すると保存されないため必ずペアで渡す)
    memory: {
      thread: THREAD_ID,
      resource: RESOURCE_ID,
    },
  });

  let streamError: unknown;
  let finishReason: string | undefined;
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let providerMetadata: unknown;
  for await (const chunk of stream.fullStream) {
    switch (chunk.type) {
      case "text-delta":
        stdout.write(chunk.payload.text);
        break;
      case "error":
        streamError = chunk.payload.error;
        break;
      case "finish":
        finishReason = chunk.payload.stepResult.reason;
        usage = chunk.payload.output.usage;
        // trace は finish チャンクの providerMetadata に載る (Mastra はメタデータ直下と payload 直下の両方に置く)
        providerMetadata = chunk.payload.metadata.providerMetadata ?? chunk.payload.providerMetadata;
        break;
    }
    if (streamError !== undefined) {
      break;
    }
  }
  if (streamError !== undefined) {
    throw streamError instanceof Error ? streamError : new Error(String(streamError));
  }

  stdout.write(
    `\n  (入力 ${usage?.inputTokens ?? "不明"} / 出力 ${usage?.outputTokens ?? "不明"} トークン)\n`,
  );

  // Guardrail の判定内容
  if (finishReason === "content-filter") {
    console.log("  ⚠ Guardrail が介入しました (上記の文言は Guardrail の拒否応答です)");
  }
  const trace = extractGuardrailTrace(providerMetadata);
  if (trace === undefined) {
    console.log("  Guardrail trace: なし (trace が無効か、メタデータが返っていません)");
    return;
  }
  console.log("  Guardrail trace:");
  for (const line of formatGuardrailTrace(trace)) {
    console.log(`    - ${line}`);
  }
}

/**
 * 起動時に会話スレッドの状態を表示する (05 と同じ)。
 */
async function printThreadStatus(): Promise<void> {
  const thread = await memory.getThreadById({
    threadId: THREAD_ID,
    resourceId: RESOURCE_ID,
  });
  if (thread === null) {
    console.log(`新規スレッド "${THREAD_ID}" を開始します。`);
    return;
  }
  const { total } = await memory.recall({
    threadId: THREAD_ID,
    resourceId: RESOURCE_ID,
    perPage: 1,
  });
  console.log(`既存スレッド "${THREAD_ID}" を再開します (これまでのメッセージ: ${total} 件)。`);
}

/**
 * 対話ループ本体。
 */
async function main(): Promise<void> {
  console.log(`モデル: ${MODEL_ID}`);
  console.log(`リージョン: ${AWS_REGION} / プロファイル: ${AWS_PROFILE}`);
  console.log(`Guardrail: ${GUARDRAIL_ID} (version ${GUARDRAIL_VERSION})`);
  console.log(`Contextual grounding の根拠付与: ${GROUNDING_CHECK_ENABLED ? "有効" : "無効 (GROUNDING_CHECK=off)"}`);
  console.log(`履歴 DB: ${DB_PATH}`);
  await printThreadStatus();
  console.log('質問を入力してください。"exit" または Ctrl+D で終了します。\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });

  // Ctrl+D などで入力が閉じられても rl.question() の Promise は解決も拒否もされず pending のまま残るため、
  // close を別 Promise で監視して race で終了を検知する (pending の Promise は GC に任せる意図的な設計)
  let inputClosed = false;
  const closed = new Promise<null>((resolve) => {
    rl.once("close", () => {
      inputClosed = true;
      resolve(null);
    });
  });

  while (true) {
    if (inputClosed) {
      break;
    }
    const answer = await Promise.race([rl.question("あなた> "), closed]);
    if (answer === null) {
      break;
    }
    const question = answer.trim();

    if (question === "") {
      continue;
    }
    if (question === "exit" || question === "quit") {
      break;
    }

    stdout.write("\nAI> ");

    try {
      await streamReply(question);
      stdout.write("\n");
    } catch (error) {
      console.error(
        `\nエラーが発生しました: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  rl.close();
  console.log("\n終了します。");
}

await main();
