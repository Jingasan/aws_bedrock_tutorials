#============================================================
# IAM Role / Policy
# Claude 5 系向けの新しい Bedrock エンドポイント (bedrock-mantle) の
# Messages API を呼び出すための IAM ポリシーを管理する。
# bedrock-mantle では従来の bedrock:InvokeModel* ではなく
# bedrock-mantle:CreateInference が推論の認可アクションとなり、
# 対象リソースはモデルではなくプロジェクト (project/*) になる。
# なお bedrock-mantle はアプリケーション推論プロファイル (01 で作成した
# コスト配分タグ付きプロファイル) に非対応のため、本構成では IAM ポリシーのみ作成する。
#============================================================

# 実行アカウントの ID をポリシーの Resource に埋め込むために参照
data "aws_caller_identity" "current" {}

# スクリプト実行ユーザーにアタッチして使う呼び出し許可ポリシー
# 参考: AWS 管理ポリシー AmazonBedrockMantleInferenceAccess
# https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonBedrockMantleInferenceAccess.html
resource "aws_iam_policy" "invoke_claude" {
  # ポリシー名
  name = "${var.project_name}-invoke"
  # ポリシーの説明 (英数字のみ推奨)
  description = "Allow invoking Claude via the Bedrock Mantle Messages API"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvokeClaudeViaBedrockMantle"
        Effect = "Allow"
        Action = [
          # Messages API (bedrock-mantle) の推論実行 (ストリーミング含む)
          "bedrock-mantle:CreateInference",
        ]
        # 自アカウントのプロジェクトに限定する (AWS 管理ポリシーは *:*:project/* と全アカウント許可のため、
        # 最小権限の観点からアカウント ID で絞る)。
        # グローバルルーティングのモデルでも認可はリクエスト先エンドポイントのリージョンで行われるため、
        # 利用リージョンを var.aws_region に限定する。別リージョンのエンドポイントも使う場合はここを広げる。
        Resource = [
          "arn:aws:bedrock-mantle:${var.aws_region}:${data.aws_caller_identity.current.account_id}:project/*",
        ]
      }
    ]
  })
}
