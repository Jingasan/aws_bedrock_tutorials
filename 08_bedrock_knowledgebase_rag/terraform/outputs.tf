#============================================================
# 出力値
# PDF アップロードと取り込み、アプリの環境変数設定に必要な情報を出力する。
#============================================================

# グローバル推論プロファイルの ID を組み立てるローカル値 (07 と同じ)。
# 東京は In-Region / jp Geo 未提供のため global を使う。
locals {
  global_inference_profile_id = "global.${var.base_model_id}"
}

# アプリ側の AWS_REGION 環境変数に合わせるリージョン
output "aws_region" {
  description = "利用リージョン"
  value       = var.aws_region
}

# アプリの BEDROCK_MODEL_ID に指定するモデル ID (グローバル推論プロファイル ID)
output "model_id" {
  description = "チャット応答生成に使うグローバル推論プロファイル ID"
  value       = local.global_inference_profile_id
}

# アプリの BEDROCK_KNOWLEDGE_BASE_ID に指定する Knowledge Base ID
output "knowledge_base_id" {
  description = "Mastra ツールが Retrieve する Knowledge Base の ID"
  value       = aws_bedrockagent_knowledge_base.rules.id
}

# 取り込みジョブの対象となるデータソース ID
output "data_source_id" {
  description = "PDF を取り込むデータソースの ID"
  value       = aws_bedrockagent_data_source.rules_pdf.data_source_id
}

# PDF をアップロードするバケット名
output "documents_bucket_name" {
  description = "社内規則 PDF を配置する S3 バケット名"
  value       = aws_s3_bucket.documents.bucket
}

# PDF アップロードのコマンド例 (ローカルの PDF ディレクトリを同期する)
output "upload_command" {
  description = "PDF を S3 に同期する AWS CLI コマンド例"
  value       = "aws s3 sync <PDF ディレクトリ> s3://${aws_s3_bucket.documents.bucket}/ --exclude '*' --include '*.pdf' --profile ${var.aws_profile}"
}

# 取り込みジョブを開始するコマンド例 (PDF 追加・更新のたびに実行する)
output "ingestion_command" {
  description = "取り込みジョブを開始する AWS CLI コマンド例"
  value       = "aws bedrock-agent start-ingestion-job --knowledge-base-id ${aws_bedrockagent_knowledge_base.rules.id} --data-source-id ${aws_bedrockagent_data_source.rules_pdf.data_source_id} --region ${var.aws_region} --profile ${var.aws_profile}"
}
