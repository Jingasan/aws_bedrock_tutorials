# 02. Messages API (bedrock-mantle) 対話型チャットスクリプト

Claude 5 系専用の新しい Bedrock エンドポイント (bedrock-mantle) の Anthropic Messages API を使い、ローカルの Node.js から Claude Sonnet 5 に質問して回答をストリーミング表示する対話型チャットスクリプトです。[01_converse_stream_api](../01_converse_stream_api/README.md) の Messages API 版です。

## 構成

- モデル: Claude Sonnet 5 (`anthropic.claude-sonnet-5`、グローバルルーティング)
- エンドポイント: `https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages`
- 認証: AWS プロファイル `default` (SigV4 署名は SDK が自動処理)
- `src/`: TypeScript の対話型チャットスクリプト (Node.js 24 のネイティブ型ストリッピングで直接実行)

> **01 との違い**: Claude 5 系 (Opus 5 / Sonnet 5 など) は従来型の Converse/ConverseStream API では利用できず、Messages API ベースの新しい Bedrock エンドポイント (bedrock-mantle) 経由で提供されます。リクエスト/レスポンスの形式は Anthropic ファーストパーティ API と同一で、SDK も AWS SDK ではなく Anthropic の `@anthropic-ai/bedrock-sdk` (`AnthropicBedrockMantle` クライアント) を使います。IAM の認可アクションも `bedrock:InvokeModel*` ではなく `bedrock-mantle:CreateInference` (対象はプロジェクトリソース) に変わります。

> **ルーティングと料金**: グローバルルーティング (`anthropic.claude-sonnet-5`) が基本料金で最安・最高可用性です。データレジデンシー要件がある場合は日本国内ルーティングの `jp.anthropic.claude-sonnet-5` を指定できますが、グローバル比で 10% のプレミアム料金がかかります。また、bedrock-mantle はアプリケーション推論プロファイル (01 で使ったコスト配分タグ付きプロファイル) に非対応です。

> **エンドポイントリージョンについて**: bedrock-mantle はリージョンごとに独自のモデルカタログを持ち、推論プロファイル ID (`jp.` / `global.` プレフィックス) は受け付けません。2026-08 時点で東京 (`ap-northeast-1`) の mantle エンドポイントは Claude Sonnet 5 未提供 (404) のため、デフォルトの接続先は提供済みの `us-east-1` にしています。モデルはグローバルルーティングのため、推論の実行リージョン自体はエンドポイントに固定されません。東京で提供が始まったら `AWS_REGION=ap-northeast-1` で切り替えられます。

## 前提条件

1. AWS プロファイル `default` が設定済みであること (`aws sts get-caller-identity` で確認)
2. [Bedrock コンソールのモデルアクセス](https://console.aws.amazon.com/bedrock/home#/modelaccess) で Anthropic Claude Sonnet 5 が有効化されていること
3. 実行ユーザーに Messages API (`bedrock-mantle:CreateInference`) の呼び出し権限があること

## セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

## 実行

```bash
npm run chat
```

`exit` / `quit` の入力または Ctrl+D で終了します。会話履歴はプロセス内で保持され、文脈を踏まえた連続質問ができます。

環境変数で挙動を変更できます:

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `BEDROCK_MODEL_ID` | `anthropic.claude-sonnet-5` | モデル ID (`jp.anthropic.claude-sonnet-5` で日本国内ルーティング) |
| `AWS_REGION` | `us-east-1` | 接続先 bedrock-mantle エンドポイントのリージョン (東京は Sonnet 5 未提供) |
| `AWS_PROFILE` | `default` | AWS プロファイル名 |

## 型チェック

```bash
npm run typecheck
```
