data "aws_caller_identity" "current" {}

# 基盤モデルが対象リージョンに存在することの検証を兼ねる
data "aws_bedrock_foundation_model" "claude" {
  model_id = var.base_model_id
}

locals {
  # AWS が用意するシステム定義のクロスリージョン推論プロファイル
  # jp プレフィックスは東京 (ap-northeast-1)・大阪 (ap-northeast-3) の日本国内ルーティング
  system_inference_profile_id  = "${var.cris_prefix}.${var.base_model_id}"
  system_inference_profile_arn = "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${local.system_inference_profile_id}"
}

# コスト配分タグを付けられるアプリケーション推論プロファイル
# スクリプトからはこのプロファイルの ARN を modelId として指定する
resource "aws_bedrock_inference_profile" "chat" {
  # description は英数字と : . _ - 空白のみ許容 (日本語不可)
  name        = "${var.project_name}-chat"
  description = "Claude inference profile for the ConverseStream tutorial"

  model_source {
    copy_from = local.system_inference_profile_arn
  }

  tags = {
    Purpose = "converse-stream-chat"
  }
}

# スクリプト実行ユーザーにアタッチして使う呼び出し許可ポリシー
resource "aws_iam_policy" "invoke_claude" {
  name        = "${var.project_name}-invoke"
  description = "Allow invoking Claude via Bedrock Converse and ConverseStream"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvokeClaudeViaInferenceProfile"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = [
          # アプリケーション推論プロファイル
          aws_bedrock_inference_profile.chat.arn,
          # システム定義推論プロファイル (jp.anthropic.*)
          local.system_inference_profile_arn,
          # ルーティング先リージョンの基盤モデル (jp は東京・大阪)
          "arn:aws:bedrock:*::foundation-model/${var.base_model_id}",
        ]
      }
    ]
  })
}
