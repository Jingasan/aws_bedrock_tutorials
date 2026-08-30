#============================================================
# 出力値
# アプリ (agent/) の環境変数設定と、呼び出しユーザーに付与する IAM ポリシーに必要な情報を出力する。
#============================================================

# ローカル実行ユーザーが Converse API で Guardrail を利用するために必要な権限のポリシー例
# (Lambda 実行時は iam_lambda_role.tf のロールを使うためこの出力は不要)。
# Guardrail をアタッチしたモデル呼び出しには、モデルの Invoke 権限に加えて Guardrail 自体への
# bedrock:ApplyGuardrail と、Standard tier (クロスリージョン推論) のためのプロファイル権限が必要になる。
locals {
  caller_iam_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvokeChatModel"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        # 推論プロファイル経由の場合はプロファイル ARN と転送先の基盤モデル ARN の両方が必要になるため、
        # チュートリアルではモデル ARN をワイルドカードにしている (本番では利用モデルに限定する)
        Resource = [
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/*",
        ]
      },
      {
        # Guardrail 本体に加え、Standard tier はクロスリージョン推論で評価されるため
        # Guardrail プロファイル (転送先リージョン分) への権限も必要
        Sid      = "ApplyGuardrail"
        Effect   = "Allow"
        Action   = ["bedrock:ApplyGuardrail"]
        Resource = concat([aws_bedrock_guardrail.chat.guardrail_arn], local.guardrail_profile_arns)
      },
    ]
  }
}

# Lambda で agent/ を動かす際に関数へ設定する実行ロール ARN (Guardrail 無しのモデル呼び出しを拒否する)
output "lambda_role_arn" {
  description = "Guardrail 必須の Lambda 実行ロール ARN"
  value       = aws_iam_role.lambda_guardrail.arn
}

# アプリ側の AWS_REGION 環境変数に合わせるリージョン
output "aws_region" {
  description = "利用リージョン"
  value       = var.aws_region
}

# アプリの BEDROCK_MODEL_ID に指定するモデル ID
output "model_id" {
  description = "チャット応答生成に使うモデル ID"
  value       = var.model_id
}

# アプリの BEDROCK_GUARDRAIL_ID に指定する Guardrail ID
output "guardrail_id" {
  description = "モデル呼び出しにアタッチする Guardrail の ID"
  value       = aws_bedrock_guardrail.chat.guardrail_id
}

# アプリの BEDROCK_GUARDRAIL_VERSION に指定するバージョン番号
output "guardrail_version" {
  description = "モデル呼び出しにアタッチする Guardrail のバージョン番号"
  value       = aws_bedrock_guardrail_version.chat.version
}

# Guardrail の ARN (IAM ポリシーの Resource に使う)
output "guardrail_arn" {
  description = "Guardrail の ARN"
  value       = aws_bedrock_guardrail.chat.guardrail_arn
}

# 呼び出しユーザーに付与する IAM ポリシー例 (JSON)
output "caller_iam_policy_json" {
  description = "アプリ実行ユーザーに必要な IAM ポリシーの例 (JSON)"
  value       = jsonencode(local.caller_iam_policy)
}

# アプリ起動用の環境変数設定コマンド例
output "env_command" {
  description = "agent/ を起動する際の環境変数設定コマンド例"
  value       = "export AWS_REGION=${var.aws_region} AWS_PROFILE=${var.aws_profile} BEDROCK_MODEL_ID=${var.model_id} BEDROCK_GUARDRAIL_ID=${aws_bedrock_guardrail.chat.guardrail_id} BEDROCK_GUARDRAIL_VERSION=${aws_bedrock_guardrail_version.chat.version}"
}
