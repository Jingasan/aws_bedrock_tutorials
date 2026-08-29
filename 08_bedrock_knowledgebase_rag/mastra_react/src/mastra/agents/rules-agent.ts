import path from 'node:path';
import { createAmazonBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { searchRulesTool } from '../tools/search-rules-tool';

//============================================================
// 設定値
// 接続先・モデルを環境変数で上書き可能にする (03〜07 と同じ)。
// このファイルは mastra dev サーバー (Node プロセス) 側でのみ実行され、
// AWS 認証情報がブラウザへ露出することはない。
//============================================================

// 認証情報の解決に使う AWS プロファイル名
const AWS_PROFILE = process.env.AWS_PROFILE ?? 'default';
// bedrock-runtime エンドポイントは東京 (ap-northeast-1) からグローバルルーティングの
// Claude Sonnet 5 を利用できるため東京をデフォルトにする (03〜07 と同じ)。
const AWS_REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
// global.anthropic.claude-sonnet-5 はグローバルクロスリージョン推論プロファイル
// (基本料金・最高可用性)。東京は In-Region (anthropic.claude-sonnet-5 単体) と
// jp Geo ルーティングが未提供のため global プレフィックスが必須。
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-5';

// 社内規則 QA 用のシステムプロンプト。
// RAG では「検索結果にない内容を答えない」「出典を示す」ことが信頼性の要となるため、
// ツール利用の必須化とハルシネーション抑止を明示的に指示する。
const SYSTEM_PROMPT = `あなたは社内規則に関する質問に答えるアシスタントです。

## 回答の手順
1. 社内のルール・手続き・制度・待遇などに関する質問には、必ず searchRules ツールで規則を検索してから回答する。自分の一般知識だけで回答してはならない。
2. 検索クエリは、質問文をそのまま使うのではなく、規則の条文に含まれそうな用語 (例:「年次有給休暇 付与日数」「時間外勤務 割増」) に言い換える。1 回の検索で十分な情報が得られない場合は、言い換えたクエリで再検索してよい (最大 3 回まで)。
3. 検索結果に基づいて日本語で分かりやすく回答する。回答の末尾に「参照した規則」として、出典のファイル名とページ番号を箇条書きで示す。
4. 検索結果に該当する記述が見つからない場合は、その旨を正直に伝え、推測で回答しない。人事・総務など担当部署への確認を勧める。

## 注意
- 規則の解釈が複数考えられる場合は、その両方を示し、最終判断は担当部署に確認するよう案内する。
- 社内規則と無関係な雑談や一般的な質問には、検索せずに簡潔に応答してよい。`;

// 会話履歴の保存先 SQLite ファイル。libsql の file: URL は実行時カレントディレクトリ
// 相対で解釈されるため、実行場所に依存しないようこのファイル基準の絶対パスを組み立てる
// (mastra_react ディレクトリ直下の memory.db。05_mastra_memory_bedrock と同じ配置方針)。
const MEMORY_DB_PATH = path.join(import.meta.dirname, '..', '..', '..', 'memory.db');

//============================================================
// Mastra Memory
// 会話履歴を SQLite (libsql) ファイルに永続化する (05_mastra_memory_bedrock と同じ構成)。
// 08 は Mastra Studio から利用するため、05 のような thread/resource の環境変数管理は
// 行わない (Studio がスレッド選択 UI を提供するため不要。06_mastra_studio_bedrock と同じ判断)。
//============================================================

const memory = new Memory({
  // 履歴の保存先ストレージ (libsql)。rulesAgent 専用の DB ファイルに保存する
  storage: new LibSQLStore({
    // ストレージの識別子
    id: 'rules-agent-memory-storage',
    // 保存先 SQLite ファイル (file: + 絶対パス)
    url: `file:${MEMORY_DB_PATH}`,
  }),
  options: {
    // モデルへ注入する直近メッセージ件数。
    // searchRules ツールの出力 (規則の抜粋) は 1 件あたりのサイズが大きいため、
    // 05/06 の既定値 10 ではなく、フロントエンド削除前の履歴上限と同じ 6 件に絞ってコストを抑える。
    lastMessages: 6,
  },
});

//============================================================
// Bedrock プロバイダーとエージェント定義
// Mastra のモデルルーター ("provider/model" 文字列) に Bedrock プロバイダーは存在しない
// ため、AI SDK の Bedrock Anthropic プロバイダーでモデルインスタンスを生成して渡す。
//============================================================

// AI SDK の Bedrock Anthropic プロバイダー。bedrock-runtime の InvokeModel /
// InvokeModelWithResponseStream を Anthropic Messages API ネイティブ形式で呼び出す。
// SigV4 署名は SDK が自動で行い、認証情報は AWS SDK の標準チェーン
// (fromNodeProviderChain) からプロファイル指定で解決する。
const bedrockAnthropic = createAmazonBedrockAnthropic({
  region: AWS_REGION,
  credentialProvider: fromNodeProviderChain({ profile: AWS_PROFILE }),
});

// Bedrock Knowledge Base の検索ツールを使って社内規則の質問に答えるエージェント (Agentic RAG)。
// RetrieveAndGenerate API ではなく Retrieve + ツール呼び出しにすることで、生成モデル・
// プロンプトを Mastra 側で制御でき、出典情報をツール出力として確認できる。
// 会話履歴は Memory (上記) で永続化し、Mastra Studio からスレッドを選択して対話する。
export const rulesAgent = new Agent({
  // エージェントの一意識別子。Mastra Studio 上での表示・識別に用いられる。
  id: 'rules-agent',
  // エージェントの表示名
  name: 'Company Rules Agent',
  // エージェントの説明
  description: 'Bedrock Knowledge Base に取り込んだ社内規則 PDF を検索して質問に答えるエージェント。',
  // エージェントの役割定義 (Anthropic Messages API の system プロンプトに相当)
  instructions: SYSTEM_PROMPT,
  // AI SDK のモデルインスタンス
  model: bedrockAnthropic(MODEL_ID),
  // 利用可能なツール。キー名 (searchRules) がモデルに提示されるツール名となる。
  tools: { searchRules: searchRulesTool },
  // 会話履歴の永続化 (上記 Memory インスタンス)
  memory,
  // generate/stream (Mastra Studio からの呼び出しを含む) の既定オプション。
  defaultOptions: {
    // ツール呼び出し → 結果を受けた再生成 のループ上限。
    // システムプロンプトで再検索を最大 3 回に制限しているため、
    // 検索 3 回 + 最終回答 1 回 = 4 ステップに余裕を持たせて 5 とする (コスト暴走防止)。
    maxSteps: 5,
    modelSettings: {
      // 応答の最大出力トークン数。無指定だとモデル上限まで生成され得るため、
      // 1 ターンあたりのコスト上限として明示する。
      maxOutputTokens: 4096,
    },
  },
});
