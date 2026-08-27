#============================================================
# バージョン制約
# Terraform 本体と AWS プロバイダの利用可能バージョンを固定する。
# S3 Vectors (aws_s3vectors_*) は AWS プロバイダ 6.24.0、Knowledge Base の
# S3_VECTORS ストレージ (s3_vectors_configuration) はさらに後のマイナーで追加されたため、
# 動作検証済みの 6.62.0 を下限とする ("~> 6.0" では 6.0.0 に解決され得て失敗する)。
#============================================================

terraform {
  # Terraform 本体の最低バージョン (variables.tf の変数間 validation に 1.9 以降が必要)
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # AWS プロバイダは検証済みバージョン以上・メジャー 6 系内に固定
      version = ">= 6.62.0, < 7.0.0"
    }
  }
}
