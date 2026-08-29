import { Mastra } from '@mastra/core/mastra';
import { rulesAgent } from './agents/rules-agent';

//============================================================
// Mastra インスタンス
// mastra dev サーバー (デフォルト http://localhost:4111) のエントリーポイント。
// 専用フロントエンドは持たず、mastra dev が提供する Mastra Studio (組み込みプレイグラウンド)
// からエージェントとチャットする。
//============================================================

export const mastra = new Mastra({
  // 公開するエージェント (Mastra Studio 上で選択して対話できる)
  agents: { rulesAgent },
});
