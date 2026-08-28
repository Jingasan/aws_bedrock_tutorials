import { productAgent } from "./mastra/agents/product-agent";

async function main() {
  console.log("エージェントに質問を送信します...");

  // エージェントにプロンプトを送信
  const response = await productAgent.generate(
    "PC周辺機器カテゴリの製品には何がありますか？",
  );

  console.log("=== 回答 ===");
  console.log(response.text);
}

main().catch(console.error);
