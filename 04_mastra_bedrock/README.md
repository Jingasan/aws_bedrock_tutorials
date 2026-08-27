# 04. Mastra (@mastra/core) 対話型チャットスクリプト

[03_ai_sdk_bedrock](../03_ai_sdk_bedrock/README.md) と同じ「Claude Sonnet 5 との対話型ストリーミングチャット」を、AI SDK を直接使うのではなく、AI エージェントフレームワーク [Mastra](https://mastra.ai/) (`@mastra/core`) で実装したチュートリアルです。

## 構成

- モデル: Claude Sonnet 5 (`global.anthropic.claude-sonnet-5`、グローバルルーティング)
- エンドポイント: bedrock-runtime (`https://bedrock-runtime.ap-northeast-1.amazonaws.com`)
- フレームワーク: `@mastra/core` の `Agent` + `@ai-sdk/amazon-bedrock/anthropic` (`bedrockAnthropic`)
- 認証: AWS プロファイル `default` (`@aws-sdk/credential-providers` の `fromNodeProviderChain` で解決、SigV4 署名は SDK が自動処理)
- `src/`: TypeScript の対話型チャットスクリプト (Node.js 24 のネイティブ型ストリッピングで直接実行)

> **03 との違い (フレームワーク)**: Mastra は AI SDK の上に乗るエージェントフレームワークです。AI SDK プロバイダーのモデルインスタンス (`bedrockAnthropic(MODEL_ID)`) をそのまま `Agent` の `model` に渡せるため、モデル呼び出し・認証まわりのコードは 03 と共通です。一方で 03 が呼び出しごとに `streamText({ model, system, messages })` へ全設定を渡していたのに対し、Mastra ではモデル・システムプロンプト (`instructions`)・(将来的にはツールやメモリも) を `Agent` という再利用可能な単位に束ね、呼び出し側は `agent.stream(messages)` だけで済みます。

> **03 との違い (ストリーム消費)**: AI SDK の `streamText` はエラーを `onError` コールバックで受けましたが、Mastra の `agent.stream()` はテキスト差分・エラー・完了 (トークン使用量) をすべてチャンクとして流す `fullStream` を持つため、1 つの `for await` ループでチャンク種別 (`text-delta` / `error` / `finish`) を振り分けて処理しています。テキストだけ欲しい場合は 03 同様の `textStream` も利用できます。

> **IAM は 03 と同一**: Mastra はモデル呼び出しに AI SDK の Bedrock プロバイダーをそのまま使うため、必要な権限は `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` で変わりません。

## 前提条件

1. AWS プロファイル `default` が設定済みであること (`aws sts get-caller-identity` で確認)
2. [Bedrock コンソールのモデルアクセス](https://console.aws.amazon.com/bedrock/home#/modelaccess) で Anthropic Claude Sonnet 5 が有効化されていること
3. 実行ユーザーに `bedrock:InvokeModel` / `InvokeModelWithResponseStream` の呼び出し権限があること (03 と同一権限のため、03 で用意済みであればそのまま利用可)

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
