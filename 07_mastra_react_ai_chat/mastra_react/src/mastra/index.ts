import { Mastra } from '@mastra/core/mastra';
import { chatRoute } from '@mastra/ai-sdk';
import { chatAgent } from './agents/chat-agent';

//============================================================
// Mastra インスタンス
// mastra dev サーバー (デフォルト http://localhost:4111) のエントリーポイント。
// @mastra/ai-sdk の chatRoute で AI SDK UI (useChat) 互換のチャット API を公開し、
// React フロントエンド (Vite) からストリーミングで呼び出せるようにする。
//============================================================

export const mastra = new Mastra({
  // 公開するエージェント (URL パスの :agentId は Agent の id で解決される)
  agents: { chatAgent },
  server: {
    // CORS 設定。フロントエンドは別オリジン (Vite の開発サーバー) で動くため、
    // 既定の全許可ではなく Vite のオリジンのみに絞って許可する。
    cors: {
      // 許可するオリジン (Vite 開発サーバーのデフォルトポート 5173)
      origin: ['http://localhost:5173'],
      // 許可する HTTP メソッド (chatRoute は POST のみだがプリフライトの OPTIONS も必要)
      allowMethods: ['POST', 'OPTIONS'],
      // 許可するリクエストヘッダー (useChat は JSON ボディを送信する)
      allowHeaders: ['Content-Type'],
    },
    // AI SDK UI 互換のカスタム API ルート。
    // POST /chat/chat-agent が useChat の UIMessage 配列を受け取り、
    // 対応するエージェントの応答を UI Message Stream 形式でストリーミングする。
    apiRoutes: [
      chatRoute({
        // :agentId 部分に Agent の id を指定して呼び出す。
        // このルートは Mastra に登録した全エージェントを URL で解決できるため、
        // エージェントを追加する際は公開してよいものだけを agents に登録すること
        // (公開範囲を絞る場合は path: '/chat', agent: '<id>' の固定指定にする)。
        path: '/chat/:agentId',
        // 全リクエストに適用される既定の実行オプション
        defaultOptions: {
          modelSettings: {
            // 応答の最大出力トークン数。無指定だとモデル上限まで生成され得るため、
            // 1 ターンあたりのコスト上限として明示する (03〜05 と同じ値)。
            maxOutputTokens: 4096,
          },
        },
      }),
    ],
  },
});
