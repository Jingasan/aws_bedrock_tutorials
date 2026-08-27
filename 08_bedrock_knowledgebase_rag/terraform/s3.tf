#============================================================
# データソース S3 バケット
# 社内規則 PDF を配置し、Knowledge Base のデータソースとして取り込むバケット。
# PDF はリポジトリにコミットせず、`aws s3 cp` で直接アップロードする運用とする。
# 社内文書を扱うためパブリックアクセスは全ブロック・暗号化必須・バージョニング有効とする。
#============================================================

# 実行アカウントの ID (バケット名の一意化と IAM Condition に使う)
data "aws_caller_identity" "current" {}

# 社内規則 PDF を配置するバケット。
# バケット名はグローバルで一意である必要があるためアカウント ID とリージョンを付与する。
resource "aws_s3_bucket" "documents" {
  # バケット名
  bucket = "${var.project_name}-docs-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
  # destroy 時にオブジェクトが残っていても削除する (チュートリアル用途のため true。
  # 本番で誤削除を防ぐ場合は false にし、prevent_destroy も検討する)
  force_destroy = true
}

# パブリックアクセスの全ブロック (社内文書のため必ず全項目 true)
resource "aws_s3_bucket_public_access_block" "documents" {
  bucket = aws_s3_bucket.documents.id

  # パブリック ACL の付与を拒否
  block_public_acls = true
  # パブリックバケットポリシーの設定を拒否
  block_public_policy = true
  # 既存のパブリック ACL を無視
  ignore_public_acls = true
  # パブリックポリシーがあってもクロスアカウントアクセスを制限
  restrict_public_buckets = true
}

# バージョニング (PDF 差し替え時の誤上書きから復旧できるようにする)
resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id

  versioning_configuration {
    # 状態 (Enabled: 有効 / Suspended: 停止)
    status = "Enabled"
  }
}

# ライフサイクルルール。バージョニング有効下では PDF を差し替えるたびに旧バージョンが残り
# ストレージ料金が単調増加するため、一定期間で旧バージョンを失効させる。
# 併せて中断したマルチパートアップロードの断片 (課金対象) も破棄する。
resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    # ルール ID
    id = "expire-noncurrent-versions-and-abort-mpu"
    # ルールの状態 (Enabled / Disabled)
    status = "Enabled"
    # バケット全体を対象にする (空フィルタ)
    filter {}

    # 旧バージョンは 30 日で削除 (誤上書きからの復旧猶予を確保しつつ課金を抑える)
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    # 中断したマルチパートアップロードの断片を 7 日で破棄
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  # バージョニング設定後に適用する
  depends_on = [aws_s3_bucket_versioning.documents]
}

# サーバーサイド暗号化。kms_key_arn が指定されていれば SSE-KMS、空なら SSE-S3 (AES256)
resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    apply_server_side_encryption_by_default {
      # 暗号化方式 (AES256: SSE-S3 / aws:kms: SSE-KMS)
      sse_algorithm = var.kms_key_arn == "" ? "AES256" : "aws:kms"
      # SSE-KMS のときだけキー ARN を指定する
      kms_master_key_id = var.kms_key_arn == "" ? null : var.kms_key_arn
    }
    # SSE-KMS の場合に KMS API 呼び出し回数を減らしコストを下げる Bucket Key を有効化
    bucket_key_enabled = var.kms_key_arn != ""
  }
}

# 平文 (HTTP) でのアクセスを拒否するバケットポリシー (転送中の暗号化を強制)
resource "aws_s3_bucket_policy" "documents" {
  bucket = aws_s3_bucket.documents.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.documents.arn,
          "${aws_s3_bucket.documents.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      }
    ]
  })

  # パブリックアクセスブロック適用後にポリシーを設定する (順序依存による競合回避)
  depends_on = [aws_s3_bucket_public_access_block.documents]
}
