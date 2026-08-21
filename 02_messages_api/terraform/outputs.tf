# 実行ユーザー/ロールにアタッチする IAM ポリシーの ARN
output "invoke_policy_arn" {
  description = "実行ユーザー/ロールにアタッチする IAM ポリシーの ARN"
  value       = aws_iam_policy.invoke_claude.arn
}

# 利用リージョン (bedrock-mantle エンドポイントのリージョン)
output "aws_region" {
  description = "利用リージョン"
  value       = var.aws_region
}

# スクリプトが接続する bedrock-mantle エンドポイント URL
output "bedrock_mantle_endpoint" {
  description = "Messages API を提供する bedrock-mantle エンドポイント URL"
  value       = "https://bedrock-mantle.${var.aws_region}.api.aws/anthropic/v1/messages"
}
