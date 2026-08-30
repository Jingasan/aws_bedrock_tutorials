#============================================================
# Bedrock Guardrail
# チャットエージェントのモデル呼び出し (Converse API の guardrailConfig) にアタッチする Guardrail 本体。
# チュートリアルとして Guardrails が提供する全ポリシー種別を 1 つの Guardrail に定義する:
#   - コンテンツフィルター (有害コンテンツ 5 分類 + プロンプト攻撃)
#   - 禁止トピック (競合製品の話題)
#   - ワードフィルター (冒涜語の管理リスト + カスタム語)
#   - 機密情報フィルター (PII のマスク/ブロック + 正規表現)
#   - Contextual grounding (RAG の根拠との整合性・質問との関連性)
# 日本語を扱うため、コンテンツフィルターと禁止トピックは Standard tier + クロスリージョン推論を有効にする
# (Classic tier は英/仏/西のみ対応)。
#============================================================

# 有害コンテンツフィルターの対象分類。全分類に同じ強度を適用する (PROMPT_ATTACK は仕様が異なるため別ブロック)。
#   SEXUAL: 性的な内容 / VIOLENCE: 暴力 / HATE: 差別・ヘイト / INSULTS: 侮辱 / MISCONDUCT: 犯罪・不正行為の助長
locals {
  harmful_content_filter_types = ["SEXUAL", "VIOLENCE", "HATE", "INSULTS", "MISCONDUCT"]

  # 機密情報フィルターの対象 PII 種別と動作。
  # 連絡先系は ANONYMIZE (種別名でマスクして会話を継続)、認証情報・決済情報は BLOCK (会話に含めること自体を禁止)。
  # 入力側・出力側とも同じ動作を適用する。
  pii_entity_actions = {
    EMAIL                    = "ANONYMIZE"
    PHONE                    = "ANONYMIZE"
    ADDRESS                  = "ANONYMIZE"
    CREDIT_DEBIT_CARD_NUMBER = "BLOCK"
    PASSWORD                 = "BLOCK"
    AWS_ACCESS_KEY           = "BLOCK"
    AWS_SECRET_KEY           = "BLOCK"
  }
}

# 実行アカウントの ID (Guardrail プロファイル ARN と outputs.tf の IAM ポリシー例の組み立てに使う)
data "aws_caller_identity" "current" {}

# クロスリージョン推論の Guardrail プロファイル ARN。
# API は ID (apac.guardrail.v1:0) も受け付けるが、Terraform プロバイダは ARN 形式を要求する
# ("The provided value cannot be parsed as an ARN") ため、自アカウント・自リージョンの ARN に変換して渡す
locals {
  guardrail_profile_arn = "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:guardrail-profile/${var.guardrail_profile_identifier}"

  # 呼び出し側 IAM (outputs.tf のポリシー例・iam_lambda_role.tf) の bedrock:ApplyGuardrail に許可するプロファイル ARN。
  # クロスリージョン推論では転送先リージョンすべての guardrail-profile ARN が必要になる
  guardrail_profile_arns = [
    for region in var.guardrail_profile_destination_regions :
    "arn:aws:bedrock:${region}:${data.aws_caller_identity.current.account_id}:guardrail-profile/${var.guardrail_profile_identifier}"
  ]
}

# Guardrail 本体 (DRAFT バージョン)。実行時には下の aws_bedrock_guardrail_version が発行する番号付きバージョンを使う
resource "aws_bedrock_guardrail" "chat" {
  # Guardrail 名 (1〜50 文字、英数字とハイフン/アンダースコア)
  name = "${var.project_name}-guardrail"
  # 説明
  description = "Tutorial guardrail covering all policy types (content, topic, word, PII, grounding)"

  # ユーザー入力がブロックされたときにモデル応答の代わりに返される文言。
  # アプリはこの文言をそのまま表示するため、利用者向けの日本語にしておく
  blocked_input_messaging = "申し訳ありません。その入力は利用ポリシーによりブロックされました。別の質問をお試しください。"
  # モデル応答がブロックされたときに返される文言
  blocked_outputs_messaging = "申し訳ありません。生成された応答は利用ポリシーによりブロックされました。質問を変えてお試しください。"

  # Guardrail 定義の暗号化キー (空なら AWS 管理キー)
  kms_key_arn = var.kms_key_arn == "" ? null : var.kms_key_arn

  # クロスリージョン推論の Guardrail プロファイル (ARN 形式)。Standard tier の必須条件
  cross_region_config {
    guardrail_profile_identifier = local.guardrail_profile_arn
  }

  #----------------------------------------
  # コンテンツフィルター
  # ユーザー入力 (input) とモデル出力 (output) それぞれの危険度を判定し、強度以上の確信度でブロックする。
  #----------------------------------------
  content_policy_config {
    # 有害コンテンツ 5 分類
    dynamic "filters_config" {
      for_each = local.harmful_content_filter_types
      content {
        # 分類
        type = filters_config.value
        # 入力側強度 (NONE/LOW/MEDIUM/HIGH)
        input_strength = var.content_filter_input_strength
        # 出力側強度 (NONE/LOW/MEDIUM/HIGH)
        output_strength = var.content_filter_output_strength
        # 評価対象のモダリティ (TEXT / IMAGE)。API 側のデフォルトは TEXT だが、apply 後の差分を防ぐため明示する
        input_modalities  = ["TEXT"]
        output_modalities = ["TEXT"]
      }
    }

    # プロンプト攻撃 (Jailbreak / Prompt Injection) の検知。
    # 攻撃はユーザー入力にしか存在しないため、仕様上 output_strength は NONE 固定 (それ以外は ValidationException)。
    filters_config {
      type              = "PROMPT_ATTACK"
      input_strength    = "HIGH"
      output_strength   = "NONE"
      input_modalities  = ["TEXT"]
      output_modalities = ["TEXT"]
    }

    # 判定モデルの世代 (CLASSIC: 英/仏/西のみ / STANDARD: 日本語を含む多言語・コード内の有害表現・プロンプト漏洩検知に対応)。
    # STANDARD には cross_region_config が必須
    tier_config {
      tier_name = "STANDARD"
    }
  }

  #----------------------------------------
  # 禁止トピック
  # 自然言語でトピックを定義し、該当する入力・出力をブロックする。
  #----------------------------------------
  topic_policy_config {
    topics_config {
      # トピック名 (英数字・ハイフン・アンダースコア・スペース等の ASCII のみ)
      name = "competitor-products"
      # トピックの定義 (Standard tier は最大 1,000 文字 / Classic は 200 文字)。
      # 判定モデルはこの定義文を基準に類似度を判断するため、対象と対象外を具体的に書く
      definition = "他社・競合の AI サービスやクラウドサービス (例: 他社の生成 AI プラットフォーム、他社クラウドの機械学習サービス) について、機能比較・価格比較・推奨・乗り換え提案・評価を求めたり回答したりする話題。自社サービスの一般的な使い方の説明は含まない。"
      # 該当例 (最大 5 件、各 100 文字以内)。判定精度向上のためのフューショット
      examples = [
        "他社の生成 AI と比べてどちらが優れていますか？",
        "競合クラウドの AI サービスに乗り換えるべきですか？",
        "他社製品の料金と比較してください",
      ]
      # 動作 (DENY のみ)
      type = "DENY"
    }

    # 判定モデルの世代 (コンテンツフィルターと同様、日本語には STANDARD が必要)
    tier_config {
      tier_name = "STANDARD"
    }
  }

  #----------------------------------------
  # ワードフィルター
  # 完全一致で入力・出力をブロックする。無料。対応言語は英/仏/西のみ (日本語のカスタム語は一致しないことがある)。
  #----------------------------------------
  word_policy_config {
    # AWS 管理の冒涜語リスト (PROFANITY のみ)
    managed_word_lists_config {
      type = "PROFANITY"
    }
    # カスタム語 (各 100 文字以内・最大 10,000 語)。社外秘のコードネームなど
    words_config {
      text = "Project Phoenix"
    }
    words_config {
      text = "極秘プロジェクト"
    }
  }

  #----------------------------------------
  # 機密情報フィルター
  # PII を検出し、ANONYMIZE (種別名でマスク。例: {EMAIL}) または BLOCK する。日本語対応。
  # 入力側と出力側で動作を分けられる (input_action / output_action)。
  #----------------------------------------
  sensitive_information_policy_config {
    # PII 種別ごとの動作 (locals.pii_entity_actions)。
    # action は input_action / output_action 未指定時の既定動作だが、プロバイダが読み戻す値との差分 (perpetual diff)
    # を避けるため 3 つとも明示している
    dynamic "pii_entities_config" {
      for_each = local.pii_entity_actions
      content {
        # PII 種別
        type = pii_entities_config.key
        # 既定動作 (BLOCK / ANONYMIZE / NONE)
        action = pii_entities_config.value
        # 入力側の動作と有効化
        input_action  = pii_entities_config.value
        input_enabled = true
        # 出力側の動作と有効化
        output_action  = pii_entities_config.value
        output_enabled = true
      }
    }

    # 正規表現による独自パターン (無料・lookaround 非対応・パターン 500 文字以内)。
    # マイナンバー (12 桁。ハイフン区切り / スペース区切り / 区切りなし) は組み込み PII に無いため正規表現でブロックする。
    # 区切り文字を後方参照で揃える書き方は Guardrails の正規表現エンジンで非対応の恐れがあるため 3 形式を列挙する。
    # 注意: 区切りなしの形式は「任意の 12 桁数字」に一致するため、注文番号などの 12 桁数値も誤ってブロックする
    regexes_config {
      # パターン名 (1〜100 文字)
      name = "jp-my-number"
      # 説明
      description = "Japanese Individual Number (My Number): 12 digits, hyphen/space-grouped by 4 or ungrouped"
      # 正規表現
      pattern = "\\b\\d{4}-\\d{4}-\\d{4}\\b|\\b\\d{4} \\d{4} \\d{4}\\b|\\b\\d{12}\\b"
      # 動作 (BLOCK / ANONYMIZE / NONE)
      action         = "BLOCK"
      input_action   = "BLOCK"
      input_enabled  = true
      output_action  = "BLOCK"
      output_enabled = true
    }
    # 社員番号 (EMP-6 桁) はマスクして会話を継続させる。マスク結果はパターン名で置換される (例: {jp-employee-id})
    regexes_config {
      name           = "jp-employee-id"
      description    = "Internal employee ID in the form EMP-nnnnnn"
      pattern        = "\\bEMP-\\d{6}\\b"
      action         = "ANONYMIZE"
      input_action   = "ANONYMIZE"
      input_enabled  = true
      output_action  = "ANONYMIZE"
      output_enabled = true
    }
  }

  #----------------------------------------
  # Contextual grounding
  # アプリが guardContent (grounding_source / query) で渡した根拠テキストと質問に対し、モデル応答の
  # 根拠性 (GROUNDING) と関連性 (RELEVANCE) のスコアを算出し、閾値未満をブロックする。出力側のみ評価される。
  # 対応言語は英/仏/西のみ (日本語は非対応のため閾値は緩めにしている。variables.tf 参照)。
  #----------------------------------------
  contextual_grounding_policy_config {
    filters_config {
      # 応答が根拠テキストに基づいているか
      type      = "GROUNDING"
      threshold = var.grounding_threshold
    }
    filters_config {
      # 応答が質問に答えているか
      type      = "RELEVANCE"
      threshold = var.relevance_threshold
    }
  }
}

#============================================================
# Guardrail バージョン
# 実行時に参照する不変の番号付きバージョン。DRAFT を直接使うと Terraform で定義を変更した瞬間に
# 稼働中アプリの挙動が変わるため、明示的に発行したバージョンをアプリへ渡す。
#============================================================

# 番号付きバージョン。Guardrail 本体が更新されるたびに新しいバージョンを発行する
resource "aws_bedrock_guardrail_version" "chat" {
  # 対象 Guardrail
  guardrail_arn = aws_bedrock_guardrail.chat.guardrail_arn
  # バージョンの説明
  description = "Version managed by terraform for ${var.project_name}"
  # destroy 時にバージョンを残さない (チュートリアル用途。本番で監査上残したい場合は true)
  skip_destroy = false

  lifecycle {
    # Guardrail 本体 (ポリシー定義) が変わっても version リソース自体の引数は変わらず更新が走らないため、
    # 本体の変更をトリガーにバージョンを再発行する (description やタグの変更でも発火する)
    replace_triggered_by = [aws_bedrock_guardrail.chat]
    # 新バージョンを作ってから旧バージョンを削除する。既定 (削除→作成) だと、アプリの BEDROCK_GUARDRAIL_VERSION を
    # 更新するまでの間、存在しないバージョンを参照して呼び出しが失敗する
    create_before_destroy = true
  }
}
