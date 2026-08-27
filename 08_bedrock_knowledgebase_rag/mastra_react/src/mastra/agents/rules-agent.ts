import { createAmazonBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { Agent } from '@mastra/core/agent';
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
// プロンプト・ストリーミングを 07 と同じ構成のまま Mastra 側で制御でき、
// 出典情報を UI に渡せる。
// React フロントエンドの useChat が毎リクエストで全メッセージ履歴を送信するため、
// サーバー側での履歴永続化 (Memory) は付けない最小構成とする (07 と同じ)。
export const rulesAgent = new Agent({
  // エージェントの一意識別子。chatRoute の URL パス (/chat/rules-agent) がこの id で
  // エージェントを解決するため、フロントエンドの接続先と一致させること。
  id: 'rules-agent',
  // エージェントの表示名
  name: 'Company Rules Agent',
  // エージェントの説明
  description: 'Bedrock Knowledge Base に取り込んだ社内規則 PDF を検索して質問に答えるエージェント。',
  // エージェントの役割定義 (Anthropic Messages API の system プロンプトに相当)
  instructions: SYSTEM_PROMPT,
  // AI SDK のモデルインスタンス
  model: bedrockAnthropic(MODEL_ID),
  // 利用可能なツール。キー名 (searchRules) がモデルに提示されるツール名となり、
  // フロントエンドでは UIMessage の part.type === 'tool-searchRules' として現れる。
  tools: { searchRules: searchRulesTool },
});
