#============================================================
# IAM Policy
# bedrock-runtime エンドポイントの InvokeModel / InvokeModelWithResponseStream で
# Claude Sonnet 5 (グローバルルーティング) を呼び出すための IAM ポリシーを管理する。
# グローバルルーティングの認可では、グローバル推論プロファイルとルーティング先の
# 基盤モデルの両方の ARN を Resource に含める必要がある。
# Mastra の Memory 機能はローカル SQLite (libSQL) ファイルへの永続化であり
# AWS リソースを一切使わないため、必要な IAM 権限は 03 (AI SDK 直接利用) /
# 04 (Mastra Agent) と同一である。チュートリアルの主題が Mastra Memory のため、
# コスト配分タグ用のアプリケーション推論プロファイルは作成せず、
# IAM ポリシーのみの最小構成とする (プロファイル自体は無料だが本題から外れるため)。
#============================================================

# 実行アカウントの ID を推論プロファイル ARN に埋め込むために参照
data "aws_caller_identity" "current" {}

# グローバル推論プロファイルの ID / ARN を組み立てるローカル値
locals {
  # AWS が用意するシステム定義のグローバルクロスリージョン推論プロファイル。
  # global プレフィックスは全世界ルーティング (基本料金・最高可用性)。
  # 東京は In-Region / jp Geo 未提供のため global を使う。
  global_inference_profile_id = "global.${var.base_model_id}"
  # 推論プロファイル ARN のリージョンは呼び出し元リージョン、アカウント ID は自アカウント
  global_inference_profile_arn = "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${local.global_inference_profile_id}"
}

# スクリプト実行ユーザーにアタッチして使う呼び出し許可ポリシー
resource "aws_iam_policy" "invoke_claude" {
  # ポリシー名
  name = "${var.project_name}-invoke"
  # ポリシーの説明 (英数字のみ推奨)
  description = "Allow invoking Claude Sonnet 5 via Bedrock InvokeModel with global routing"

  # ポリシードキュメント本体
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "InvokeClaudeViaGlobalInferenceProfile"
        Effect = "Allow"
        Action = [
          # Messages API 形式の推論実行 (AI SDK の bedrockAnthropic が使用)
          "bedrock:InvokeModel",
          # ストリーミング応答 (agent.stream のストリーミングが使用)
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = [
          # システム定義グローバル推論プロファイル (global.anthropic.*)
          local.global_inference_profile_arn,
          # グローバルルーティングのルーティング先は全リージョンに及ぶため、
          # 基盤モデルはリージョンをワイルドカードで許可する
          "arn:aws:bedrock:*::foundation-model/${var.base_model_id}",
        ]
        # 基盤モデルのリージョンワイルドカードだけでは、推論プロファイルを経由しない
        # 他リージョンのエンドポイントへの直接呼び出しまで許可されてしまうため、
        # 呼び出し元リージョンを利用リージョンに固定して最小権限に絞る。
        # ルーティング先へのファンアウトは Bedrock サービス側で行われ、リクエスト
        # コンテキストのリージョンは呼び出し元のままのため、グローバルルーティングは
        # 阻害されない。別リージョンのエンドポイントも使う場合は var.aws_region を変更する。
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = var.aws_region
          }
        }
      }
    ]
  })
}
