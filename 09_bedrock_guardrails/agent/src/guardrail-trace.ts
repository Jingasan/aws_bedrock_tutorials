/**
 * Bedrock Guardrails の trace (判定結果) を人が読める行に整形するモジュール。
 *
 * Converse API で guardrailConfig.trace を有効にすると、応答メタデータの
 * trace.guardrail に「入力に対する判定 (inputAssessment)」と「出力に対する判定 (outputAssessments)」
 * が含まれる。AI SDK はこれを providerMetadata.bedrock.trace としてそのまま公開する。
 * 型は AWS SDK の GuardrailTraceAssessment に準拠しているが、AI SDK 経由では unknown で届くため
 * ここで最小限の型を定義して安全に読み出す。
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_GuardrailAssessment.html
 */

/** 各ポリシーの判定 1 件に共通するフィールド */
interface PolicyHit {
  /** 取られた動作 (BLOCKED / ANONYMIZED / NONE) */
  action?: string;
  /** 検出されたか (trace: enabled_full のときは未検出の項目も含まれるため区別に使う) */
  detected?: boolean;
}

/** 1 回の評価 (入力または出力 1 件分) の判定内容 */
interface GuardrailAssessment {
  topicPolicy?: { topics?: Array<PolicyHit & { name?: string; type?: string }> };
  contentPolicy?: {
    filters?: Array<PolicyHit & { type?: string; confidence?: string; filterStrength?: string }>;
  };
  wordPolicy?: {
    customWords?: Array<PolicyHit & { match?: string }>;
    managedWordLists?: Array<PolicyHit & { match?: string; type?: string }>;
  };
  sensitiveInformationPolicy?: {
    piiEntities?: Array<PolicyHit & { type?: string; match?: string }>;
    regexes?: Array<PolicyHit & { name?: string; match?: string }>;
  };
  contextualGroundingPolicy?: {
    filters?: Array<PolicyHit & { type?: string; score?: number; threshold?: number }>;
  };
  invocationMetrics?: {
    guardrailProcessingLatency?: number;
    usage?: Record<string, number>;
  };
}

/** trace.guardrail の形 (キーは Guardrail ID) */
interface GuardrailTrace {
  inputAssessment?: Record<string, GuardrailAssessment>;
  outputAssessments?: Record<string, GuardrailAssessment[]>;
  actionReason?: string;
}

/**
 * providerMetadata から Guardrail の trace を取り出す。
 *
 * @param providerMetadata finish チャンクの providerMetadata (プロバイダー固有メタデータ)
 * @returns trace.guardrail。trace が無効・未介入で省略された場合は undefined
 */
export function extractGuardrailTrace(providerMetadata: unknown): GuardrailTrace | undefined {
  if (typeof providerMetadata !== "object" || providerMetadata === null) {
    return undefined;
  }
  const bedrock = (providerMetadata as { bedrock?: { trace?: { guardrail?: unknown } } }).bedrock;
  const guardrail = bedrock?.trace?.guardrail;
  if (typeof guardrail !== "object" || guardrail === null) {
    return undefined;
  }
  return guardrail as GuardrailTrace;
}

/** 判定 1 件分の表示行。介入 (ブロック/マスク) と、常に返る grounding スコアを分けて持つ */
interface AssessmentLines {
  /** ポリシーが介入した項目 */
  interventions: string[];
  /** Contextual grounding のスコア (介入の有無に関わらず表示する) */
  groundingScores: string[];
}

/**
 * 外部 API のレスポンスを配列として安全に読む。AWS 側の形が変わっても for...of で例外にならないようにする。
 *
 * @param value 配列であることが期待される値
 * @returns 配列ならそのまま、そうでなければ空配列
 */
function asArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 1 件の判定 (assessment) からポリシー種別ごとの介入内容を行に変換する。
 * detected が明示的に false の項目 (trace: enabled_full で返る未検出項目) は除外する。
 *
 * @param assessment 判定内容
 * @returns 表示行
 */
function describeAssessment(assessment: GuardrailAssessment): AssessmentLines {
  const lines: string[] = [];
  const groundingScores: string[] = [];
  const isHit = (hit: PolicyHit): boolean => hit.detected !== false;

  for (const topic of asArray(assessment.topicPolicy?.topics)) {
    if (isHit(topic)) {
      lines.push(`禁止トピック "${topic.name ?? "?"}" → ${topic.action ?? "?"}`);
    }
  }
  for (const filter of asArray(assessment.contentPolicy?.filters)) {
    if (isHit(filter)) {
      lines.push(
        `コンテンツフィルター ${filter.type ?? "?"} (確信度 ${filter.confidence ?? "?"} / 強度 ${filter.filterStrength ?? "?"}) → ${filter.action ?? "?"}`,
      );
    }
  }
  for (const word of asArray(assessment.wordPolicy?.customWords)) {
    if (isHit(word)) {
      lines.push(`カスタム語 "${word.match ?? "?"}" → ${word.action ?? "?"}`);
    }
  }
  for (const word of asArray(assessment.wordPolicy?.managedWordLists)) {
    if (isHit(word)) {
      lines.push(`管理語リスト ${word.type ?? "?"} "${word.match ?? "?"}" → ${word.action ?? "?"}`);
    }
  }
  for (const pii of asArray(assessment.sensitiveInformationPolicy?.piiEntities)) {
    if (isHit(pii)) {
      // match には元の PII 値がそのまま入るため、種別と動作のみ表示して値はログに出さない
      lines.push(`PII ${pii.type ?? "?"} → ${pii.action ?? "?"}`);
    }
  }
  for (const regex of asArray(assessment.sensitiveInformationPolicy?.regexes)) {
    if (isHit(regex)) {
      lines.push(`正規表現 "${regex.name ?? "?"}" → ${regex.action ?? "?"}`);
    }
  }
  for (const filter of asArray(assessment.contextualGroundingPolicy?.filters)) {
    // grounding はスコアが常に返るため、介入行とは別にして閾値と並べて表示する
    const score = filter.score?.toFixed(2) ?? "?";
    const threshold = filter.threshold?.toFixed(2) ?? "?";
    const result = filter.action === "BLOCKED" ? "BLOCKED" : "OK";
    groundingScores.push(`Grounding ${filter.type ?? "?"} スコア ${score} (閾値 ${threshold}) → ${result}`);
  }
  return { interventions: lines, groundingScores };
}

/**
 * Guardrail の trace を表示用の行に整形する。
 *
 * @param trace extractGuardrailTrace の戻り値
 * @returns 表示行。介入もスコアも無ければ「介入なし」の 1 行
 */
export function formatGuardrailTrace(trace: GuardrailTrace): string[] {
  const interventions: string[] = [];
  const groundingScores: string[] = [];

  const collect = (label: string, assessment: GuardrailAssessment): void => {
    const described = describeAssessment(assessment);
    interventions.push(...described.interventions.map((line) => `${label} ${line}`));
    groundingScores.push(...described.groundingScores.map((line) => `${label} ${line}`));
  };
  for (const assessment of Object.values(trace.inputAssessment ?? {})) {
    collect("[入力]", assessment);
  }
  for (const assessments of Object.values(trace.outputAssessments ?? {})) {
    for (const assessment of asArray(assessments)) {
      collect("[出力]", assessment);
    }
  }

  // 介入行が無ければ「介入なし」を明示し、grounding スコアは介入の有無に関わらず続けて表示する
  const lines = interventions.length === 0 ? ["介入なし"] : interventions;
  lines.push(...groundingScores);
  if (trace.actionReason !== undefined) {
    lines.push(`理由: ${trace.actionReason}`);
  }
  return lines;
}
