#============================================================
# 入力変数
# リージョン・プロファイル・モデル ID などデプロイ時に調整するパラメータを定義する。
#============================================================

# 利用する AWS リージョン (bedrock-runtime エンドポイントのリージョン)。
# Claude Sonnet 5 は東京 (ap-northeast-1) では In-Region / jp Geo ルーティング未提供だが、
# グローバルルーティング (global.*) は利用可能なため、東京をデフォルトとする。
# IAM ポリシーの Condition で呼び出し元リージョンをこの値に固定しているため、
# スクリプト側の AWS_REGION を変える場合はこの変数も合わせて変更する。
variable "aws_region" {
  description = "利用する AWS リージョン (bedrock-runtime のグローバルルーティング対応リージョン)"
  type        = string
  default     = "ap-northeast-1"
}

# Terraform 実行に使う AWS プロファイル名 (スクリプト側の AWS_PROFILE と合わせる)
variable "aws_profile" {
  description = "利用する AWS プロファイル名"
  type        = string
  default     = "default"
}

# IAM ポリシー名 (<project_name>-invoke) と default_tags の Project タグに使うプロジェクト名
variable "project_name" {
  description = "リソース名やタグに使うプロジェクト名"
  type        = string
  default     = "ai-sdk-bedrock-tutorial"
}

# 基盤モデル ID。main.tf 側で global. プレフィックスを付けてグローバル推論プロファイル ID
# (global.anthropic.claude-sonnet-5) を組み立て、スクリプトはその ID を modelId に指定する。
# 東京は In-Region 未提供でリージョンのモデルカタログに載らないため、
# aws_bedrock_foundation_model データソースによる存在検証は行えない。
variable "base_model_id" {
  description = "Claude の基盤モデル ID (global プレフィックスなし)"
  type        = string
  default     = "anthropic.claude-sonnet-5"

  # global. の二重付与 (global.global.…) は apply が通って実行時にだけ失敗するため事前に弾く
  validation {
    condition     = !startswith(var.base_model_id, "global.")
    error_message = "base_model_id には global. プレフィックスを含めないこと (main.tf 側で付与する)。"
  }
}
