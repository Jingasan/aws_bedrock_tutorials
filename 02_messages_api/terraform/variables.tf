# 利用する AWS リージョン。bedrock-mantle エンドポイントが存在するリージョンであること。
# mantle はリージョンごとに独自のモデルカタログを持ち、東京 (ap-northeast-1) は
# Claude Sonnet 5 を未提供のため、提供済みの us-east-1 をデフォルトとする
# (スクリプト側のデフォルトと合わせる)。
variable "aws_region" {
  description = "利用する AWS リージョン (bedrock-mantle 対応かつ対象モデル提供済みリージョン)"
  type        = string
  default     = "us-east-1"
}

# Terraform 実行に使う AWS プロファイル名
variable "aws_profile" {
  description = "利用する AWS プロファイル名"
  type        = string
  default     = "default"
}

# リソース名やタグに使うプロジェクト名
variable "project_name" {
  description = "リソース名やタグに使うプロジェクト名"
  type        = string
  default     = "messages-api-tutorial"
}
