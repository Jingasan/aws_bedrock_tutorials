# 03. AI SDK (@ai-sdk/amazon-bedrock) 対話型チャットスクリプト

[02_messages_api](../02_messages_api/README.md) と同じ「Claude Sonnet 5 との対話型ストリーミングチャット」を、Anthropic SDK ではなく Vercel AI SDK (`ai` + `@ai-sdk/amazon-bedrock`) で実装したチュートリアルです。

## 構成

- モデル: Claude Sonnet 5 (`global.anthropic.claude-sonnet-5`、グローバルルーティング)
- エンドポイント: bedrock-runtime (`https://bedrock-runtime.ap-northeast-1.amazonaws.com`)
- SDK: `ai` (`streamText`) + `@ai-sdk/amazon-bedrock/anthropic` (`bedrockAnthropic`)
- 認証: AWS プロファイル `default` (`@aws-sdk/credential-providers` の `fromNodeProviderChain` で解決、SigV4 署名は SDK が自動処理)
- `src/`: TypeScript の対話型チャットスクリプト (Node.js 24 のネイティブ型ストリッピングで直接実行)

> **02 との違い (SDK)**: AI SDK はプロバイダー抽象化レイヤーを持つマルチプロバイダーの TypeScript ツールキットです。`bedrockAnthropic` サブプロバイダーは bedrock-runtime の InvokeModel / InvokeModelWithResponseStream を Anthropic Messages API ネイティブ形式で呼び出すため、Anthropic API と同等の機能を AI SDK の統一インターフェース (`streamText` / `generateText`) から利用できます。なお AI SDK の `bedrockMantle` サブプロバイダーは OpenAI 互換モデル (`openai.gpt-oss-*` 等) 専用のため、02 の bedrock-mantle エンドポイントの直接の置き換えではありません。

> **02 との違い (エンドポイントとリージョン)**: 02 実装時点では Claude 5 系は bedrock-mantle 専用でしたが、現在は bedrock-runtime (Invoke / Converse API) でも提供されています。bedrock-runtime は東京 (ap-northeast-1) からグローバルルーティング (`global.` プレフィックス) のモデルを利用できるため、02 のような us-east-1 への迂回は不要で、デフォルトリージョンを東京にしています。東京は In-Region (`anthropic.claude-sonnet-5` 単体) と jp Geo ルーティングが未提供のため、`global.` プレフィックスが必須です。

> **IAM の違い**: bedrock-mantle の `bedrock-mantle:CreateInference` (対象はプロジェクトリソース) ではなく、従来型の `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` (対象はグローバル推論プロファイルとルーティング先の基盤モデル) に戻ります。

## 前提条件

1. AWS プロファイル `default` が設定済みであること (`aws sts get-caller-identity` で確認)
2. [Bedrock コンソールのモデルアクセス](https://console.aws.amazon.com/bedrock/home#/modelaccess) で Anthropic Claude Sonnet 5 が有効化されていること
3. 実行ユーザーに `bedrock:InvokeModel` / `InvokeModelWithResponseStream` の呼び出し権限があること

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
| `BEDROCK_MODEL_ID` | `global.anthropic.claude-sonnet-5` | モデル ID (グローバル推論プロファイル ID) |
| `AWS_REGION` | `ap-northeast-1` | 接続先 bedrock-runtime エンドポイントのリージョン |
| `AWS_PROFILE` | `default` | AWS プロファイル名 |

## 型チェック

```bash
npm run typecheck
```
