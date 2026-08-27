#============================================================
# Bedrock Knowledge Base とデータソース
# 社内規則 PDF をベクトル化して S3 Vectors に保存し、Retrieve API で検索できるようにする。
# 取り込みジョブ (StartIngestionJob) は Terraform では管理せず、PDF アップロード後に
# AWS CLI で実行する (outputs.tf の ingestion_command を参照)。
#============================================================

# ベクトル型 Knowledge Base 本体
resource "aws_bedrockagent_knowledge_base" "rules" {
  # Knowledge Base 名
  name = "${var.project_name}-kb"
  # 説明
  description = "Company rules and regulations (PDF) for RAG chat"
  # サービスロール (iam_kb_role.tf)
  role_arn = aws_iam_role.knowledge_base.arn

  knowledge_base_configuration {
    # Knowledge Base の種類 (VECTOR: ベクトル検索 / KENDRA: Kendra 連携 / SQL: 構造化データ)
    type = "VECTOR"

    vector_knowledge_base_configuration {
      # 埋め込みモデルの ARN (取り込み・クエリの両方で使用。変更時は再作成が必要)
      embedding_model_arn = local.embedding_model_arn

      embedding_model_configuration {
        bedrock_embedding_model_configuration {
          # 出力ベクトルの次元数 (S3 Vectors インデックスの dimension と一致させる)
          dimensions = var.embedding_dimensions
          # ベクトル要素のデータ型 (FLOAT32 / BINARY。S3 Vectors は FLOAT32 のみ)
          embedding_data_type = "FLOAT32"
        }
      }
    }
  }

  storage_configuration {
    # ベクトルストアの種類 (S3_VECTORS / OPENSEARCH_SERVERLESS / OPENSEARCH_MANAGED_CLUSTER /
    # RDS / PINECONE / MONGO_DB_ATLAS / REDIS_ENTERPRISE_CLOUD / NEPTUNE_ANALYTICS)。
    # コスト最小の S3_VECTORS を採用 (s3_vectors.tf 冒頭のコメント参照)。
    type = "S3_VECTORS"

    s3_vectors_configuration {
      # 保存先インデックスの ARN
      index_arn = aws_s3vectors_index.kb.index_arn
    }
  }

  # サービスロールのポリシーが揃う前に KB を作成すると権限検証で失敗するため明示的に依存させる
  depends_on = [
    aws_iam_role_policy.knowledge_base_embedding,
    aws_iam_role_policy.knowledge_base_s3,
    aws_iam_role_policy.knowledge_base_s3vectors,
  ]
}

# S3 バケットを読み込むデータソース (PDF の取り込み元とチャンク分割の設定)
resource "aws_bedrockagent_data_source" "rules_pdf" {
  # 所属する Knowledge Base
  knowledge_base_id = aws_bedrockagent_knowledge_base.rules.id
  # データソース名
  name = "${var.project_name}-s3-docs"
  # 説明
  description = "Company rules PDF files in S3"

  # データソース削除時のベクトル扱い (DELETE: ベクトルも削除 / RETAIN: 残す)。
  # チュートリアル用途のため destroy で全て消える DELETE にする。
  data_deletion_policy = "DELETE"

  data_source_configuration {
    # データソースの種類 (S3 / WEB / CONFLUENCE / SALESFORCE / SHAREPOINT / CUSTOM)
    type = "S3"

    s3_configuration {
      # 取り込み元バケットの ARN (バケット全体を対象とする)
      bucket_arn = aws_s3_bucket.documents.arn
      # 取り込み元バケットの所有アカウント (クロスアカウント誤参照の防止)
      bucket_owner_account_id = data.aws_caller_identity.current.account_id
    }
  }

  # parsing_configuration は未指定 (既定のテキスト抽出パーサー) とする。
  # テキストレイヤーを持つ PDF が前提で、スキャン画像のみの PDF は本文が抽出されず
  # 「取り込みは成功するが検索結果が空」になる。その場合は parsing_configuration で
  # BEDROCK_FOUNDATION_MODEL または BEDROCK_DATA_AUTOMATION を指定する (別途推論コストが発生)。
  vector_ingestion_configuration {
    chunking_configuration {
      # チャンク分割戦略 (FIXED_SIZE: 固定長 / HIERARCHICAL: 階層 / SEMANTIC: 意味 / NONE: 分割なし)。
      # 規則文書は「章 > 条 > 項」の階層構造を持つため、小さな子チャンクで精度良く検索しつつ、
      # 結果として親チャンクを返して前後文脈を生成モデルに渡せる HIERARCHICAL を採用する。
      chunking_strategy = "HIERARCHICAL"

      hierarchical_chunking_configuration {
        # 子チャンク間のオーバーラップトークン数
        overlap_tokens = var.chunk_overlap_tokens

        # レベル設定は必ず 2 つ (1 つ目が親、2 つ目が子)
        # 親チャンク: Retrieve の結果として返される単位
        level_configuration {
          max_tokens = var.parent_chunk_max_tokens
        }
        # 子チャンク: 埋め込み・検索される単位
        level_configuration {
          max_tokens = var.child_chunk_max_tokens
        }
      }
    }
  }
}
