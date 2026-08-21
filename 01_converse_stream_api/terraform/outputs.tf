output "inference_profile_arn" {
  description = "スクリプトの modelId に指定するアプリケーション推論プロファイル ARN"
  value       = aws_bedrock_inference_profile.chat.arn
}

output "system_inference_profile_id" {
  description = "システム定義のクロスリージョン推論プロファイル ID"
  value       = local.system_inference_profile_id
}

output "invoke_policy_arn" {
  description = "実行ユーザー/ロールにアタッチする IAM ポリシーの ARN"
  value       = aws_iam_policy.invoke_claude.arn
}

output "aws_region" {
  description = "利用リージョン"
  value       = var.aws_region
}
