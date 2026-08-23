import { createAmazonBedrockAnthropic } from '@ai-sdk/amazon-bedrock/anthropic';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

//============================================================
// 設定値
// 接続先・モデルを環境変数で上書き可能にする (05_mastra_memory_bedrock と同じ)。
// 05 にあった thread/resource の固定値は、Studio がスレッド管理 UI を持つため不要。
//============================================================

// 認証情報の解決に使う AWS プロファイル名
const AWS_PROFILE = process.env.AWS_PROFILE ?? 'default';
// bedrock-runtime エンドポイントは東京 (ap-northeast-1) からグローバルルーティングの
// Claude Sonnet 5 を利用できるため東京をデフォルトにする (03〜05 と同じ)。
const AWS_REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
// global.anthropic.claude-sonnet-5 はグローバルクロスリージョン推論プロファイル
// (基本料金・最高可用性)。東京は In-Region (anthropic.claude-sonnet-5 単体) と
// jp Geo ルーティングが未提供のため global プレフィックスが必須。
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-5';

// 05 と同じシステムプロンプト。Mastra ではエージェント定義の instructions として宣言する。
const SYSTEM_PROMPT =
  'あなたは親切なアシスタントです。ユーザーの質問に日本語で分かりやすく回答してください。';

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

// Bedrock 経由の Claude と会話する日本語チャットエージェント。
// Studio のチャット画面から利用でき、会話履歴は Memory がスレッド単位で永続化する。
export const bedrockChatAgent = new Agent({
  // エージェントの一意識別子 (Mastra インスタンスへ登録する際のキーにも使われる)
  id: 'bedrock-chat-agent',
  // エージェントの表示名 (Studio の一覧に表示される)
  name: 'Bedrock Chat Agent',
  // エージェントの説明 (Studio の一覧に表示される)
  description:
    'Amazon Bedrock の Claude Sonnet 5 と日本語で会話するチャットエージェント。会話履歴は Memory で永続化される。',
  // エージェントの役割定義 (Anthropic Messages API の system プロンプトに相当)
  instructions: SYSTEM_PROMPT,
  // AI SDK のモデルインスタンス
  model: bedrockAnthropic(MODEL_ID),
  // 会話履歴の永続化。ストレージを個別指定せず、Mastra インスタンス登録済みの
  // composite storage (LibSQL) を継承する (既存 agent と同じパターン)。
  memory: new Memory({
    options: {
      // モデルへ注入する直近メッセージ件数 (デフォルト 10 / false で注入無効)。
      // 増やすほど長い文脈を保てる代わりに毎ターンの入力トークンが増える。
      lastMessages: 10,
    },
  }),
});
