import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
  type KnowledgeBaseRetrievalResult,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

//============================================================
// 設定値
// Knowledge Base の接続先を環境変数から取得する。
// このファイルは mastra dev サーバー (Node プロセス) 側でのみ実行され、
// AWS 認証情報がブラウザへ露出することはない。
//============================================================

// 認証情報の解決に使う AWS プロファイル名
const AWS_PROFILE = process.env.AWS_PROFILE ?? 'default';
// Knowledge Base を作成したリージョン (terraform の aws_region と合わせる)
const AWS_REGION = process.env.AWS_REGION ?? 'ap-northeast-1';
// 検索対象の Knowledge Base ID (terraform output knowledge_base_id)。
// 未設定だと検索できないため起動時に明示的に失敗させる。
const KNOWLEDGE_BASE_ID = process.env.BEDROCK_KNOWLEDGE_BASE_ID;
if (KNOWLEDGE_BASE_ID === undefined || KNOWLEDGE_BASE_ID === '') {
  throw new Error(
    'BEDROCK_KNOWLEDGE_BASE_ID が未設定です。terraform output knowledge_base_id の値を .env に設定してください。',
  );
}

// 1 回の検索で取得する規則チャンクの既定件数。
// 多いほど回答の網羅性は上がるが、その分 Claude への入力トークン (= コスト) が増える。
// 親チャンク 1500 トークン × 5 件 ≒ 7,500 トークン/回が上限の目安。
const DEFAULT_NUMBER_OF_RESULTS = 5;
// モデルが指定できる取得件数の上限 (コスト暴走防止のガードレール)
const MAX_NUMBER_OF_RESULTS = 10;

// Knowledge Base が各チャンクに付与するページ番号のメタデータキー (PDF の場合のみ付く)
const PAGE_NUMBER_METADATA_KEY = 'x-amz-bedrock-kb-document-page-number';

//============================================================
// Bedrock Agent Runtime クライアント
// Retrieve API (質問文のベクトル化 → S3 Vectors の類似検索) を呼び出す。
// 埋め込みは Knowledge Base 側で行われるため、アプリは埋め込みモデルを直接呼ばない。
//============================================================

const bedrockAgentRuntime = new BedrockAgentRuntimeClient({
  region: AWS_REGION,
  credentials: fromNodeProviderChain({ profile: AWS_PROFILE }),
});

//============================================================
// 検索結果の整形
//============================================================

/** ツールが返す規則チャンク 1 件分のスキーマ */
const ruleChunkSchema = z.object({
  // 規則本文の抜粋 (階層チャンクの親チャンク)
  text: z.string(),
  // 検索スコア (0〜1。距離メトリクスが cosine のため大きいほど類似)
  score: z.number().nullable(),
  // 出典 PDF のファイル名 (S3 キーの末尾)
  source: z.string(),
  // 出典 PDF の S3 URI
  uri: z.string(),
  // 出典ページ番号 (取得できない場合は null)
  page: z.number().nullable(),
});

/**
 * Retrieve API の 1 件分の結果を、モデルと UI が扱いやすい形へ整形する。
 *
 * @param result - Retrieve API の retrievalResults 要素
 * @returns 整形済みチャンク
 */
const toRuleChunk = (result: KnowledgeBaseRetrievalResult): z.infer<typeof ruleChunkSchema> => {
  const uri = result.location?.s3Location?.uri ?? '';
  // S3 URI の末尾をファイル名として扱う (s3://bucket/dir/file.pdf → file.pdf)
  const source = uri.split('/').at(-1) ?? uri;
  // メタデータのページ番号は数値または文字列で返るため数値へ正規化する
  const rawPage = result.metadata?.[PAGE_NUMBER_METADATA_KEY];
  const page = typeof rawPage === 'number' || typeof rawPage === 'string' ? Number(rawPage) : NaN;

  return {
    text: result.content?.text ?? '',
    score: result.score ?? null,
    source,
    uri,
    page: Number.isFinite(page) ? page : null,
  };
};

//============================================================
// ツール定義
//============================================================

/**
 * 社内規則を Bedrock Knowledge Base から意味検索するツール。
 *
 * エージェント (Claude) がユーザーの質問に答える際に呼び出し、
 * 関連する規則の抜粋と出典 (ファイル名・ページ) を取得する。
 */
export const searchRulesTool = createTool({
  // ツール ID (モデルへ提示されるツール名は Agent 側の tools のキー名になる)
  id: 'search-rules',
  // モデルがツールを使う判断に用いる説明
  description:
    '社内規則・規程の PDF から、質問に関連する条文や記述を意味検索して返す。' +
    '社内のルール・手続き・制度に関する質問に回答する前に必ず呼び出すこと。',
  inputSchema: z.object({
    // 検索クエリ。会話文そのままではなく、規則に出てきそうな用語で書き直すとヒット率が上がる
    query: z
      .string()
      .min(1)
      .describe('検索クエリ。質問の意図を表す規則上の用語やキーワードで簡潔に記述する'),
    // 取得件数 (省略時は既定値。上限でコストを抑える)
    numberOfResults: z
      .number()
      .int()
      .min(1)
      .max(MAX_NUMBER_OF_RESULTS)
      .optional()
      .describe(`取得する抜粋の件数 (1〜${MAX_NUMBER_OF_RESULTS}、既定 ${DEFAULT_NUMBER_OF_RESULTS})`),
  }),
  outputSchema: z.object({
    // 関連度順に並んだ規則の抜粋
    results: z.array(ruleChunkSchema),
  }),
  execute: async ({ query, numberOfResults }) => {
    try {
      const response = await bedrockAgentRuntime.send(
        new RetrieveCommand({
          knowledgeBaseId: KNOWLEDGE_BASE_ID,
          retrievalQuery: { text: query },
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults: numberOfResults ?? DEFAULT_NUMBER_OF_RESULTS,
            },
          },
        }),
      );

      return {
        results: (response.retrievalResults ?? []).map(toRuleChunk),
      };
    } catch (error) {
      // AWS SDK の例外メッセージは IAM ロール ARN や KB ID などの内部構成を含み得るため、
      // 詳細はサーバー側ログにのみ残し、ブラウザへはツールエラーとして汎用メッセージだけを返す。
      console.error('Knowledge Base の検索に失敗しました', error);
      throw new Error('規則の検索に失敗しました。時間を置いて再度お試しください。');
    }
  },
});
