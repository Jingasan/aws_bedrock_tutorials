#============================================================
# Knowledge Base サービスロール
# Bedrock Knowledge Bases サービスが取り込み・検索時に引き受ける IAM ロール。
# 埋め込みモデルの呼び出し、データソース S3 の読み取り、S3 Vectors インデックスの
# 読み書きを、それぞれ対象リソースを限定した最小権限で許可する。
#============================================================

# Knowledge Base ARN を信頼ポリシーの aws:SourceArn 条件に使うために組み立てる。
# (ロール作成前に KB は存在しないため、ID 部分はワイルドカードにする)
locals {
  knowledge_base_arn_pattern = "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:knowledge-base/*"
  embedding_model_arn        = "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.embedding_model_id}"
}

# Bedrock Knowledge Bases サービスが引き受けるロール
resource "aws_iam_role" "knowledge_base" {
  # ロール名 (IAM ロール名は最大 64 文字。Bedrock コンソール既定の接頭辞
  # AmazonBedrockExecutionRoleForKnowledgeBase_ は 43 文字あり project_name と合わせると
  # 上限を超えるため、短い独自命名にする)
  name = "${var.project_name}-kb-role"
  # ロールの説明
  description = "Service role for Bedrock Knowledge Base (${var.project_name})"

  # 信頼ポリシー。混乱した代理 (confused deputy) 攻撃を防ぐため、
  # 自アカウントの Knowledge Base からの AssumeRole のみに限定する。
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowBedrockKnowledgeBaseAssume"
        Effect = "Allow"
        Principal = {
          Service = "bedrock.amazonaws.com"
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
          ArnLike = {
            "aws:SourceArn" = local.knowledge_base_arn_pattern
          }
        }
      }
    ]
  })
}

# 埋め込みモデル呼び出し許可 (取り込み時のベクトル化とクエリ時の質問ベクトル化)
resource "aws_iam_role_policy" "knowledge_base_embedding" {
  # インラインポリシー名
  name = "invoke-embedding-model"
  role = aws_iam_role.knowledge_base.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "InvokeEmbeddingModel"
        Effect   = "Allow"
        Action   = ["bedrock:InvokeModel"]
        Resource = [local.embedding_model_arn]
      }
    ]
  })
}

# データソース S3 バケットの読み取り許可 (取り込み時のオブジェクト一覧取得と本文取得)
resource "aws_iam_role_policy" "knowledge_base_s3" {
  # インラインポリシー名
  name = "read-document-bucket"
  role = aws_iam_role.knowledge_base.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [
        {
          Sid      = "ListDocumentBucket"
          Effect   = "Allow"
          Action   = ["s3:ListBucket"]
          Resource = [aws_s3_bucket.documents.arn]
          # 自アカウントのバケットに限定 (バケット名の乗っ取り対策)
          Condition = {
            StringEquals = {
              "aws:ResourceAccount" = data.aws_caller_identity.current.account_id
            }
          }
        },
        {
          Sid      = "GetDocumentObjects"
          Effect   = "Allow"
          Action   = ["s3:GetObject"]
          Resource = ["${aws_s3_bucket.documents.arn}/*"]
          Condition = {
            StringEquals = {
              "aws:ResourceAccount" = data.aws_caller_identity.current.account_id
            }
          }
        },
      ],
      # SSE-KMS を使う場合のみ、オブジェクト復号のための KMS 権限を追加する
      var.kms_key_arn == "" ? [] : [
        {
          Sid      = "DecryptDocumentObjects"
          Effect   = "Allow"
          Action   = ["kms:Decrypt"]
          Resource = [var.kms_key_arn]
          # S3 経由の利用に限定
          Condition = {
            StringEquals = {
              "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com"
            }
          }
        },
      ],
    )
  })
}

# S3 Vectors インデックスの読み書き許可 (取り込み時の書き込み・削除とクエリ時の検索)
resource "aws_iam_role_policy" "knowledge_base_s3vectors" {
  # インラインポリシー名
  name = "access-vector-index"
  role = aws_iam_role.knowledge_base.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AccessVectorIndex"
        Effect = "Allow"
        # AWS 公式のサービスロール用ポリシーと同じ 5 アクションに限定する
        Action = [
          # インデックス設定の取得 (次元数の整合性確認)
          "s3vectors:GetIndex",
          # 取り込み時のベクトル書き込み
          "s3vectors:PutVectors",
          # ベクトルの取得 (差分同期の判定)
          "s3vectors:GetVectors",
          # 削除・再取り込み時のベクトル削除
          "s3vectors:DeleteVectors",
          # クエリ時の類似検索
          "s3vectors:QueryVectors",
        ]
        Resource = [aws_s3vectors_index.kb.index_arn]
      }
    ]
  })
}
