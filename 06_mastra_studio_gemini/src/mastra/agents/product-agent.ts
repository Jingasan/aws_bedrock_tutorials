import { Agent } from "@mastra/core/agent";
import { productSearchTool } from "../tools/product-search";

export const productAgent = new Agent({
  id: "product-agent",
  name: "Product Assistant",
  instructions:
    "あなたは社内製品に詳しいアシスタントです。ユーザーの質問に対し、必ずツールを使ってデータベースを検索し、適切な回答をしてください。",
  // 使用するAIモデルを指定します（プロバイダ/モデル名の形式）
  model: "google/gemini-3.5-flash",
  tools: { productSearchTool },
});
