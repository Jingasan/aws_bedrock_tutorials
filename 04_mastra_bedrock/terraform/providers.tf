#============================================================
# AWS プロバイダ設定
# 認証プロファイルとリージョン、全リソース共通のデフォルトタグを定義する。
#============================================================

provider "aws" {
  # 接続先リージョン
  region = var.aws_region
  # 認証に使う AWS プロファイル名
  profile = var.aws_profile

  # 全リソースに共通で付与するタグ (コスト・所有者の追跡用)
  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}
