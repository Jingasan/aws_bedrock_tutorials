#============================================================
# 出力値
# 実行ユーザーへのポリシーアタッチとスクリプト実行に必要な情報を出力する。
#============================================================

# 実行ユーザー/ロールに手動アタッチする IAM ポリシーの ARN
# (例: aws iam attach-user-policy --policy-arn <この値> --user-name <ユーザー名>)
output "invoke_policy_arn" {
  description = "実行ユーザー/ロールにアタッチする IAM ポリシーの ARN"
  value       = aws_iam_policy.invoke_claude.arn
}

# スクリプト側の AWS_REGION 環境変数に合わせるリージョン
output "aws_region" {
  description = "利用リージョン"
  value       = var.aws_region
}

# スクリプトの BEDROCK_MODEL_ID に指定するモデル ID (グローバル推論プロファイル ID)
output "model_id" {
  description = "スクリプトの modelId に指定するグローバル推論プロファイル ID"
  value       = local.global_inference_profile_id
}
