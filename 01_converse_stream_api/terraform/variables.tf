variable "aws_region" {
  description = "利用する AWS リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "aws_profile" {
  description = "利用する AWS プロファイル名"
  type        = string
  default     = "default"
}

variable "project_name" {
  description = "リソース名やタグに使うプロジェクト名"
  type        = string
  default     = "converse-stream-tutorial"
}

variable "base_model_id" {
  description = "Bedrock の基盤モデル ID (Converse API 対応モデル)"
  type        = string
  default     = "anthropic.claude-sonnet-4-6"
}

variable "cris_prefix" {
  description = "クロスリージョン推論プロファイルの地理プレフィックス (jp: 日本国内ルーティング)"
  type        = string
  default     = "jp"
}
