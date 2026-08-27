# Mastra × React AI チャット

Amazon Bedrock 上の Claude Sonnet 5 と会話する AI チャットのチュートリアル。
[Mastra の Vite/React 統合ガイド](https://mastra.ai/integrations/frameworks/vite-react) をベースに、
バックエンドを Mastra + AI SDK、フロントエンドを React + `@ai-sdk/react` で構成する。

## 構成

```
ブラウザ (React + @ai-sdk/react useChat)
  │  POST /chat/chat-agent (メッセージ履歴の JSON)
  ▼
mastra dev サーバー (http://localhost:4111)
  │  @mastra/ai-sdk の chatRoute → chatAgent
  ▼
Amazon Bedrock (global.anthropic.claude-sonnet-5)
```

- `src/mastra/` … バックエンド (Node 側)
  - `agents/chat-agent.ts` … AI SDK の Bedrock Anthropic プロバイダーを使う日本語チャットエージェント
  - `index.ts` … Mastra インスタンス。`chatRoute()` で AI SDK UI 互換のチャット API を公開
- `src/App.tsx` … フロントエンド。`useChat` + `DefaultChatTransport` でストリーミング表示
- AWS 認証情報を扱うのは mastra dev サーバーのみで、ブラウザには露出しない

## コスト面のガードレール

本章は Memory を使わず `useChat` が毎リクエストで会話履歴を送信するため、
以下の上限でトークン消費を抑えている。

- 送信する履歴はフロントエンド側で直近 10 件に制限 (`App.tsx` の `MAX_SENT_MESSAGES`)
- 応答の最大出力トークン数は 4096 (`src/mastra/index.ts` の `chatRoute` の `defaultOptions`)

## 前提

- Node.js 22.13 以上
- `../terraform/` の IAM ポリシー (`bedrock:InvokeModel` / `InvokeModelWithResponseStream`) が
  適用済みで、利用する AWS プロファイルにアタッチされていること
- AWS 認証情報が標準チェーン (プロファイル等) で解決できること

## 起動方法

依存パッケージを導入する。

```bash
npm install
```

ターミナルを 2 つ使い、バックエンドとフロントエンドをそれぞれ起動する。

```bash
# ターミナル 1: Mastra バックエンド (http://localhost:4111)
npm run dev:mastra

# ターミナル 2: Vite フロントエンド (http://localhost:5173)
npm run dev
```

ブラウザで http://localhost:5173 を開き、質問を送信すると Claude Sonnet 5 の応答が
ストリーミング表示される。

## 環境変数

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `AWS_PROFILE` | `default` | 認証情報の解決に使う AWS プロファイル名 |
| `AWS_REGION` | `ap-northeast-1` | bedrock-runtime エンドポイントのリージョン |
| `BEDROCK_MODEL_ID` | `global.anthropic.claude-sonnet-5` | 呼び出すモデル (グローバル推論プロファイル) |
| `VITE_CHAT_API_URL` | `http://localhost:4111/chat/chat-agent` | フロントエンドが接続するチャット API |

## 検証コマンド

```bash
npm run typecheck  # tsc -b (app / node / mastra の 3 プロジェクト)
npm run lint       # oxlint
```
