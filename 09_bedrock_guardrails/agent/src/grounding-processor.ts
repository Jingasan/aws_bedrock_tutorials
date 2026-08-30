import type { Processor, ProcessLLMRequestArgs, ProcessLLMRequestResult } from "@mastra/core/processors";

/**
 * Contextual grounding 用に、モデルへ送る直前のプロンプトへ根拠テキスト (grounding_source) を付与する Processor。
 *
 * Bedrock Guardrails の Contextual grounding は「根拠テキスト」「質問」「モデル応答」の 3 つを
 * 突き合わせてスコアを出すため、Converse API では根拠テキストと質問を guardContent ブロックの
 * qualifiers (grounding_source / query) で明示する必要がある。AI SDK の Bedrock プロバイダーでは
 * テキストパートの providerOptions.bedrock.guardContent でこれを指定できる。
 *
 * processLLMRequest は Memory に保存される履歴には影響せず「今回モデルへ送るプロンプト」だけを書き換える
 * フックなので、毎ターン同じ根拠テキストを付けても履歴が肥大化しない。
 * https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-contextual-grounding-check.html
 */
/**
 * AI SDK Bedrock プロバイダーのテキストパート用 providerOptions.bedrock。
 * SharedV2ProviderOptions は Record<string, JSONValue> のため型検査が効かず、キー名のタイポが
 * 実行時まで検知できない。ここで形を固定して satisfies で照合する。
 */
interface BedrockGuardContentTextOptions {
  guardContent: boolean;
  guardContentQualifiers: Array<"grounding_source" | "query" | "guard_content">;
}

export class GroundingSourceProcessor implements Processor {
  readonly id = "guardrail-grounding-source";
  readonly name = "Guardrail Grounding Source";
  readonly description = "Attach grounding_source / query guardContent blocks for contextual grounding";

  /** 根拠テキスト (RAG で取得した文書に相当。チュートリアルでは固定の FAQ) */
  readonly #groundingSource: string;

  /**
   * @param groundingSource 応答の根拠とみなすテキスト (最大 100,000 文字)
   */
  constructor(groundingSource: string) {
    this.#groundingSource = groundingSource;
  }

  /**
   * 最後のユーザーメッセージに根拠テキストのパートを追加し、ユーザーの質問パートを query として印を付ける。
   *
   * qualifiers の意味:
   *   - grounding_source: 根拠テキスト。Contextual grounding の参照元としてのみ使われ、他ポリシーの評価対象外
   *   - query: 質問。Contextual grounding の質問としてのみ使われる
   *   - guard_content: 他ポリシー (コンテンツフィルター等) の評価対象にする
   * guardContent ブロックが 1 つでもあると、他ポリシーは guard_content 付きのブロックだけを評価するため、
   * 質問パートには query と guard_content の両方を付けて従来通り検査させる。
   */
  processLLMRequest({ prompt }: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    const lastUserIndex = prompt.findLastIndex((message) => message.role === "user");
    if (lastUserIndex === -1) {
      return undefined;
    }
    const lastUser = prompt[lastUserIndex];
    if (lastUser === undefined || lastUser.role !== "user") {
      return undefined;
    }

    // 質問パート: テキストは query + guard_content、画像などテキスト以外のパートも guard_content として
    // 評価対象に含める (guardContent ブロックがあると印の無いパートは他ポリシーの評価から外れるため、
    // タグ付けを漏らすとそのパートが Guardrail をバイパスしてしまう)。
    // 既存の bedrock オプション (キャッシュポイント等) を消さないよう bedrock キー配下もマージする
    const queryParts = lastUser.content.map((part) => {
      const bedrockOptions = part.providerOptions?.bedrock ?? {};
      if (part.type === "text") {
        return {
          ...part,
          providerOptions: {
            ...part.providerOptions,
            bedrock: {
              ...bedrockOptions,
              ...({
                guardContent: true,
                guardContentQualifiers: ["query", "guard_content"],
              } satisfies BedrockGuardContentTextOptions),
            },
          },
        };
      }
      return {
        ...part,
        providerOptions: {
          ...part.providerOptions,
          bedrock: { ...bedrockOptions, guardContent: true },
        },
      };
    });

    // 根拠テキストのパート: grounding_source (先頭に置くことでモデルにも「参照資料 → 質問」の順で見せる)
    const groundingPart = {
      type: "text" as const,
      text: this.#groundingSource,
      providerOptions: {
        bedrock: {
          guardContent: true,
          guardContentQualifiers: ["grounding_source"],
        } satisfies BedrockGuardContentTextOptions,
      },
    };

    const nextPrompt = [...prompt];
    nextPrompt[lastUserIndex] = { ...lastUser, content: [groundingPart, ...queryParts] };
    return { prompt: nextPrompt };
  }
}
