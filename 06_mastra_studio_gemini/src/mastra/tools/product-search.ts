import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// 外部ファイル（JSON）を直接インポートする
import dummyProducts from "../../data/products.json";

export const productSearchTool = createTool({
  id: "product-search",
  description: "ダミーの社内商品データベース（JSON）から商品を検索します",
  inputSchema: z.object({
    keyword: z
      .string()
      .describe("検索キーワード（例: マウス, PC周辺機器など）"),
  }),
  // Mastraのバージョン差異を吸収するため、ここではany型を使用しています。
  execute: async (args: any) => {
    // 引数から検索キーワードを取得する
    const searchKeyword = args?.context?.keyword || args?.keyword;

    // インポートしたダミーデータからキーワード検索を行う
    if (!searchKeyword) return dummyProducts;

    const lowerKeyword = searchKeyword.toLowerCase();
    const results = dummyProducts.filter(
      (p: any) =>
        p.name.toLowerCase().includes(lowerKeyword) ||
        p.category.toLowerCase().includes(lowerKeyword),
    );
    return results;
  },
});
