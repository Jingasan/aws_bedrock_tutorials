#============================================================
# 実行ユーザー向け IAM ポリシー
# Mastra バックエンド (Node プロセス) と運用者 (AWS CLI) が使う権限をまとめたポリシー。
#  - チャット応答生成: Claude Sonnet 5 (グローバルルーティング) の InvokeModel (07 と同じ)
#  - 検索: Knowledge Base への bedrock:Retrieve (この KB に限定)
#  - 運用: PDF アップロード (S3 PutObject) と取り込みジョブの開始・状態確認
# 実行ユーザー/ロールへのアタッチは手動で行う (outputs.tf の app_policy_arn を参照)。
#============================================================

# グローバル推論プロファイルの ID / ARN を組み立てるローカル値 (07 と同じ)
locals {
  # AWS が用意するシステム定義のグローバルクロスリージョン推論プロファイル。
  # 東京は In-Region / jp Geo 未提供のため global を使う。
  global_inference_profile_id = "global.${var.base_model_id}"
  # 推論プロファイル ARN のリージョンは呼び出し元リージョン、アカウント ID は自アカウント
  global_inference_profile_arn = "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${local.global_inference_profile_id}"
}

# 実行ユーザーにアタッチして使うアプリ・運用用ポリシー
resource "aws_iam_policy" "app" {
  # ポリシー名
  name = "${var.project_name}-app"
  # ポリシーの説明 (英数字のみ推奨)
  description = "Allow invoking Claude via global routing, retrieving from the KB, and ingesting documents"

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
        # 基盤モデルのリージョンワイルドカードだけでは他リージョンのエンドポイントへの
        # 直接呼び出しまで許可されてしまうため、呼び出し元リージョンを固定して最小権限に絞る。
        # ルーティング先へのファンアウトは Bedrock サービス側で行われるため阻害されない。
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = var.aws_region
          }
        }
      },
      {
        Sid    = "RetrieveFromKnowledgeBase"
        Effect = "Allow"
        Action = [
          # 意味検索 (bedrock-agent-runtime の Retrieve API。Mastra ツールが使用)
          "bedrock:Retrieve",
        ]
        Resource = [aws_bedrockagent_knowledge_base.rules.arn]
      },
      {
        Sid    = "ManageIngestionJobs"
        Effect = "Allow"
        Action = [
          # 取り込みジョブの開始 (PDF アップロード後に CLI で実行)
          "bedrock:StartIngestionJob",
          # 取り込みジョブの状態確認
          "bedrock:GetIngestionJob",
          "bedrock:ListIngestionJobs",
        ]
        Resource = [aws_bedrockagent_knowledge_base.rules.arn]
      },
      {
        Sid    = "ListDocumentBucket"
        Effect = "Allow"
        # アップロード済みファイルの確認 (バケットレベルのアクション)
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.documents.arn]
      },
      {
        Sid    = "PutDocumentObjects"
        Effect = "Allow"
        # オブジェクトレベルのアクション。
        # バージョニング有効のため DeleteObject は削除マーカーを付けるだけで、旧バージョンは
        # ライフサイクルルール (s3.tf) で 30 日後に自動失効させる方針とし、
        # s3:DeleteObjectVersion は付与しない。
        Action = [
          # PDF のアップロード・差し替え
          "s3:PutObject",
          # 不要になった PDF の削除 (次回取り込みでベクトルも削除される)
          "s3:DeleteObject",
        ]
        Resource = ["${aws_s3_bucket.documents.arn}/*"]
      },
    ]
  })
}
