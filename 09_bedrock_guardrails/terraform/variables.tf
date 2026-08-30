#============================================================
# 入力変数
# リージョン・プロファイル・モデル ID・Guardrail の各ポリシー強度などデプロイ時に調整するパラメータを定義する。
#============================================================

# 利用する AWS リージョン。Guardrail 本体とチャットモデルの呼び出し先を同じリージョンにする。
# 東京 (ap-northeast-1) は Guardrails の Standard tier 対応リージョンで、Nova Lite も In-Region 提供のため東京をデフォルトとする。
# 変更する場合は guardrail_profile_identifier (地理に対応したプロファイル) も合わせて変更すること。
variable "aws_region" {
  description = "利用する AWS リージョン (Guardrail と bedrock-runtime のリージョン)"
  type        = string
  default     = "ap-northeast-1"
}

# Terraform 実行に使う AWS プロファイル名 (アプリ側の AWS_PROFILE と合わせる)
variable "aws_profile" {
  description = "利用する AWS プロファイル名"
  type        = string
  default     = "default"
}

# リソース名 (<project_name>-*) と default_tags の Project タグに使うプロジェクト名。
# 03〜08 と同一アカウントに共存できるよう別名にしている。
# Guardrail 名は 1〜50 文字・英数字とハイフン/アンダースコアのみのため、それに収まる文字種に制限する。
variable "project_name" {
  description = "リソース名やタグに使うプロジェクト名 (小文字英数字とハイフン、30 文字以内)"
  type        = string
  default     = "bedrock-guardrails-tutorial"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.project_name)) && length(var.project_name) <= 30
    error_message = "project_name は小文字英数字とハイフンのみ・30 文字以内で指定すること (Guardrail 名の上限 50 文字から接尾辞 -guardrail の 10 文字を除いた安全域)。"
  }
}

# チャット応答生成に使うモデル ID (outputs.tf 経由でアプリの BEDROCK_MODEL_ID に渡す)。
# Guardrails は Converse API 経由で任意の対応モデルに適用できるため、モデルは Guardrail の設定と独立して選べる。
# 東京から利用できる Amazon Nova の選択肢:
#   amazon.nova-lite-v1:0      … In-Region (ON_DEMAND)。低コスト・高速。データが東京から出ない。デフォルト
#   apac.amazon.nova-lite-v1:0 … APAC クロスリージョン推論プロファイル (可用性向上)
#   jp.amazon.nova-2-lite-v1:0 … Nova 2 Lite の日本 Geo ルーティング (上位モデル。東京単体では未提供)
#   apac.amazon.nova-micro-v1:0 / apac.amazon.nova-pro-v1:0 … 下位/上位モデル
# Claude を使う場合は 05 と同じ global.anthropic.claude-sonnet-5 等を指定する (Converse API 対応のため差し替え可)。
variable "model_id" {
  description = "チャット応答生成に使うモデル ID (基盤モデル ID または推論プロファイル ID)"
  type        = string
  default     = "amazon.nova-lite-v1:0"
}

# Guardrail の Standard tier に必須となるクロスリージョン推論用の Guardrail プロファイル。
# Standard tier (日本語を含む多言語のコンテンツフィルター・禁止トピック) はプロファイル指定なしだと
# ValidationException になる。プロファイルはリージョンの地理 (Geo) ごとにシステム定義されている:
#   us.guardrail.v1:0   … 米国リージョン
#   eu.guardrail.v1:0   … 欧州リージョン
#   apac.guardrail.v1:0 … アジア太平洋リージョン (東京はこちら)
# Guardrail 定義自体は aws_region に保存され、評価時のプロンプト/応答のみ同一 Geo 内の他リージョンへ転送され得る。
# ここには ID のみを指定する (Terraform プロバイダが要求する ARN 形式への変換は guardrail.tf の locals で行う)。
variable "guardrail_profile_identifier" {
  description = "Standard tier で使うクロスリージョン Guardrail プロファイルの ID (例: apac.guardrail.v1:0)"
  type        = string
  default     = "apac.guardrail.v1:0"

  validation {
    condition     = !startswith(var.guardrail_profile_identifier, "arn:")
    error_message = "guardrail_profile_identifier には ID (例: apac.guardrail.v1:0) を指定すること (ARN への変換は guardrail.tf で行う)。"
  }
}

# guardrail_profile_identifier のプロファイルが評価リクエストを転送し得る先のリージョン一覧。
# クロスリージョン推論では、呼び出し側 IAM の bedrock:ApplyGuardrail に「転送先リージョンすべて」の
# guardrail-profile ARN を列挙する必要がある (source リージョンだけだと転送された瞬間に AccessDenied)。
# デフォルトは apac.guardrail.v1:0 を東京から使う場合の転送先。プロファイルやリージョンを変える場合は AWS ドキュメントの
# 「Supported Regions for guardrail profiles」に合わせて更新する。IAM ポリシー (outputs.tf の例・iam_lambda_role.tf) の Resource に使う。
variable "guardrail_profile_destination_regions" {
  description = "Guardrail プロファイルの転送先リージョン一覧 (IAM ポリシー例の Resource に使う)"
  type        = list(string)
  default = [
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-south-1",
    "ap-southeast-1",
    "ap-southeast-2",
  ]
}

# 有害コンテンツフィルター (SEXUAL / VIOLENCE / HATE / INSULTS / MISCONDUCT) の入力側強度。
# NONE: 無効 / LOW: 高確信のみブロック / MEDIUM: 中確信以上をブロック / HIGH: 低確信でもブロック (最も厳しい)。
# チュートリアルでは介入を観察しやすい HIGH をデフォルトにする。誤検知が多い場合は MEDIUM に下げる。
variable "content_filter_input_strength" {
  description = "有害コンテンツフィルターの入力 (ユーザープロンプト) 側強度 (NONE/LOW/MEDIUM/HIGH)"
  type        = string
  default     = "HIGH"

  validation {
    condition     = contains(["NONE", "LOW", "MEDIUM", "HIGH"], var.content_filter_input_strength)
    error_message = "content_filter_input_strength は NONE / LOW / MEDIUM / HIGH のいずれかを指定すること。"
  }
}

# 有害コンテンツフィルターの出力 (モデル応答) 側強度。選択肢と意味は入力側と同じ。
variable "content_filter_output_strength" {
  description = "有害コンテンツフィルターの出力 (モデル応答) 側強度 (NONE/LOW/MEDIUM/HIGH)"
  type        = string
  default     = "HIGH"

  validation {
    condition     = contains(["NONE", "LOW", "MEDIUM", "HIGH"], var.content_filter_output_strength)
    error_message = "content_filter_output_strength は NONE / LOW / MEDIUM / HIGH のいずれかを指定すること。"
  }
}

# Contextual grounding の「根拠性 (grounding)」閾値 (0〜0.99)。
# 応答が grounding_source (アプリが付与する FAQ テキスト) に基づいている確信度がこの値を下回るとブロックされる。
# 高いほど厳しい。1 は全応答をブロックするため無効。
# 注意: Contextual grounding の対応言語は英語・フランス語・スペイン語のみで、日本語ではスコアが安定しないため
# チュートリアルでは緩め (0.5) にしている。
variable "grounding_threshold" {
  description = "Contextual grounding の grounding (根拠性) 閾値 (0〜0.99)"
  type        = number
  default     = 0.5

  validation {
    condition     = var.grounding_threshold >= 0 && var.grounding_threshold <= 0.99
    error_message = "grounding_threshold は 0 以上 0.99 以下で指定すること (1 は全応答をブロックするため無効)。"
  }
}

# Contextual grounding の「関連性 (relevance)」閾値 (0〜0.99)。
# 応答がユーザーの質問 (query) に答えているかの確信度がこの値を下回るとブロックされる。意味と注意点は grounding_threshold と同じ。
variable "relevance_threshold" {
  description = "Contextual grounding の relevance (関連性) 閾値 (0〜0.99)"
  type        = number
  default     = 0.5

  validation {
    condition     = var.relevance_threshold >= 0 && var.relevance_threshold <= 0.99
    error_message = "relevance_threshold は 0 以上 0.99 以下で指定すること (1 は全応答をブロックするため無効)。"
  }
}

# Guardrail 定義 (トピック定義・カスタム語など) の暗号化に使う KMS キー ARN。
# 空文字 (デフォルト) の場合は AWS 管理キー (追加料金なし) で暗号化される。
# 組織のキー管理方針で CMK が必須な場合のみ指定する (KMS キー料金 $1/月 + API 料金が発生し、
# 呼び出し側 IAM に kms:Decrypt 等の権限も必要になる)。
variable "kms_key_arn" {
  description = "Guardrail 暗号化用 KMS キー ARN (空なら AWS 管理キー)"
  type        = string
  default     = ""
}

# Guardrail 必須の Lambda 実行ロール (iam_lambda_role.tf) を引き受けられる Lambda 関数名の接頭辞。
# 信頼ポリシーの aws:SourceArn を "arn:aws:lambda:<region>:<account>:function:<接頭辞>*" に限定し、
# 同一アカウントの無関係な Lambda がロールを引き受ける (confused deputy) のを防ぐ。
# Lambda 関数自体は本チュートリアルでは作成しないため、将来デプロイする関数名に合わせて変更する。
variable "lambda_function_name_prefix" {
  description = "Lambda 実行ロールを引き受けられる関数名の接頭辞 (信頼ポリシーの SourceArn に使う)"
  type        = string
  default     = "bedrock-guardrails-agent"
}
