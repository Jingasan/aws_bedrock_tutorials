#============================================================
# S3 Vectors (ベクトルストア)
# Knowledge Base が埋め込みベクトルを保存・検索するストア。
# OpenSearch Serverless は最小構成でも常時課金 (月 2〜3 万円規模) が発生するのに対し、
# S3 Vectors はストレージ容量とクエリ回数の従量課金のみで、数十 PDF 規模なら月数十〜数百円に収まる。
# レイテンシは 100ms〜1 秒程度と OpenSearch より大きいが、社内規則の QA チャットでは許容範囲。
#============================================================

# ベクトルバケット (通常の S3 バケットとは別種のリソース)。
# 暗号化は既定の SSE-S3 (追加料金なし) を採用する。ベクトルバケットの暗号化方式は
# 作成後に変更できないため、CMK (SSE-KMS) が必要な場合は初回作成時に
# encryption_configuration を指定すること。
resource "aws_s3vectors_vector_bucket" "kb" {
  # ベクトルバケット名 (アカウント・リージョン内で一意)
  vector_bucket_name = "${var.project_name}-vectors"
}

# ベクトルバケットポリシー。
# AWS 公式はカスタムサービスロールを使う場合、ベクトルバケット/インデックスへのアクセスを
# そのロールに限定するバケットポリシーの設定を推奨している (ID ベースポリシーとの多層防御)。
# 同一アカウント内の他プリンシパルを拒否するため Deny 型にし、Terraform 実行者自身は
# 締め出さないよう除外する (除外を外すと以後の plan/destroy が権限エラーで止まる)。
resource "aws_s3vectors_vector_bucket_policy" "kb" {
  # 対象ベクトルバケットの ARN
  vector_bucket_arn = aws_s3vectors_vector_bucket.kb.vector_bucket_arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyAllExceptKnowledgeBaseRoleAndOperator"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3vectors:*"
        Resource = [
          aws_s3vectors_vector_bucket.kb.vector_bucket_arn,
          "${aws_s3vectors_vector_bucket.kb.vector_bucket_arn}/index/*",
        ]
        Condition = {
          StringNotLike = {
            "aws:PrincipalArn" = [
              # Knowledge Base サービスロール (取り込み・検索)
              aws_iam_role.knowledge_base.arn,
              # Terraform 実行プリンシパル (このバケット・ポリシーの管理)
              data.aws_caller_identity.current.arn,
            ]
          }
        }
      }
    ]
  })
}

# ベクトルインデックス。Knowledge Base の埋め込み設定 (次元数) と一致させる必要がある。
# 次元数・距離メトリクス・メタデータ設定は作成後に変更できない (変更時は再作成 + 再取り込み)。
resource "aws_s3vectors_index" "kb" {
  # インデックス名
  index_name = "${var.project_name}-index"
  # 所属するベクトルバケット
  vector_bucket_name = aws_s3vectors_vector_bucket.kb.vector_bucket_name

  # ベクトル要素のデータ型 (float32 のみサポート)
  data_type = "float32"
  # ベクトルの次元数 (Knowledge Base の embedding_dimensions と必ず一致させる)
  dimension = var.embedding_dimensions
  # 類似度の距離メトリクス (cosine: コサイン距離 / euclidean: ユークリッド距離)。
  # Titan Text Embeddings V2 は正規化済みベクトルを返すため cosine が推奨。
  distance_metric = "cosine"

  # フィルタ不可メタデータの指定。
  # Knowledge Base はチャンク本文を AMAZON_BEDROCK_TEXT、ソース情報を AMAZON_BEDROCK_METADATA
  # というメタデータキーで保存する。フィルタ可能メタデータは 1 ベクトルあたり 2KB までの制限が
  # あるため、サイズの大きいこれらのキーはフィルタ不可 (上限 40KB) に指定しないと取り込みが失敗する。
  metadata_configuration {
    non_filterable_metadata_keys = [
      "AMAZON_BEDROCK_TEXT",
      "AMAZON_BEDROCK_METADATA",
    ]
  }
}
