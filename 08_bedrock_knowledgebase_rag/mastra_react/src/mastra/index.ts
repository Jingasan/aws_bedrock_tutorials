import { Mastra } from '@mastra/core/mastra';
import { chatRoute } from '@mastra/ai-sdk';
import { rulesAgent } from './agents/rules-agent';

//============================================================
// Mastra インスタンス
// mastra dev サーバー (デフォルト http://localhost:4111) のエントリーポイント。
// @mastra/ai-sdk の chatRoute で AI SDK UI (useChat) 互換のチャット API を公開し、
// React フロントエンド (Vite) からストリーミングで呼び出せるようにする (07 と同じ)。
//============================================================

export const mastra = new Mastra({
  // 公開するエージェント (URL パスの :agentId は Agent の id で解決される)
  agents: { rulesAgent },
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
    // POST /chat/rules-agent が useChat の UIMessage 配列を受け取り、
    // エージェントの応答 (ツール呼び出しの経過を含む) を UI Message Stream 形式でストリーミングする。
    apiRoutes: [
      chatRoute({
        // 公開するエージェントは 1 つだけのため、:agentId ではなく固定パスにして公開範囲を絞る
        path: '/chat/rules-agent',
        // エージェントは Agent の id で解決される (agents の登録キー名ではない) ため、
        // リファクタでずれないよう定義から参照する
        agent: rulesAgent.id,
        // 全リクエストに適用される既定の実行オプション
        defaultOptions: {
          // ツール呼び出し → 結果を受けた再生成 のループ上限。
          // システムプロンプトで再検索を最大 3 回に制限しているため、
          // 検索 3 回 + 最終回答 1 回 = 4 ステップに余裕を持たせて 5 とする (コスト暴走防止)。
          maxSteps: 5,
          modelSettings: {
            // 応答の最大出力トークン数。無指定だとモデル上限まで生成され得るため、
            // 1 ターンあたりのコスト上限として明示する (03〜07 と同じ値)。
            maxOutputTokens: 4096,
          },
        },
      }),
    ],
  },
});
