#============================================================
# バージョン制約
# Terraform 本体と AWS プロバイダの利用可能バージョンを固定する。
# aws_bedrock_guardrail の Standard tier (tier_config) と cross_region_config は
# AWS プロバイダ 6 系の途中で追加されたため、08 と同じ動作検証済みの 6.62.0 を下限とする。
#============================================================

terraform {
  # Terraform 本体の最低バージョン (08 と揃える)
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # AWS プロバイダは検証済みバージョン以上・メジャー 6 系内に固定
      version = ">= 6.62.0, < 7.0.0"
    }
  }
}
