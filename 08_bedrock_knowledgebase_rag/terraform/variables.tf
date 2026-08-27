#============================================================
# 入力変数
# リージョン・プロファイル・モデル ID・チャンク設定などデプロイ時に調整するパラメータを定義する。
#============================================================

# 利用する AWS リージョン。Knowledge Base / S3 Vectors / データソース S3 バケットを
# すべてこのリージョンに作成する。Titan Text Embeddings V2 と S3 Vectors の両方が
# 東京 (ap-northeast-1) で提供されているため東京をデフォルトとする。
# 生成側の Claude Sonnet 5 は 07 と同じくグローバルルーティング (global.*) を東京から呼び出す。
# IAM ポリシーの Condition で呼び出し元リージョンをこの値に固定しているため、
# アプリ側の AWS_REGION を変える場合はこの変数も合わせて変更する。
variable "aws_region" {
  description = "利用する AWS リージョン (Knowledge Base と bedrock-runtime のリージョン)"
  type        = string
  default     = "ap-northeast-1"
}

# Terraform 実行に使う AWS プロファイル名 (アプリ側の AWS_PROFILE と合わせる)
variable "aws_profile" {
  description = "利用する AWS プロファイル名"
  type        = string
  default     = "default"
}

# リソース名 (<project_name>-*) と default_tags の Project タグに使うプロジェクト名。
# 03〜07 と同一アカウントに共存できるよう別名にしている。
# S3 バケット名にも使うため、小文字英数字とハイフンのみで構成すること。
# 最長の派生名は S3 バケット名 "<project_name>-docs-<12 桁アカウント ID>-<リージョン>" (上限 63 文字)
# のため、リージョン名 14 文字 (ap-northeast-1) を想定して 30 文字以内に制限する。
variable "project_name" {
  description = "リソース名やタグに使うプロジェクト名 (小文字英数字とハイフン、30 文字以内)"
  type        = string
  default     = "bedrock-kb-rag-tutorial"

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.project_name)) && length(var.project_name) <= 30
    error_message = "project_name は小文字英数字とハイフンのみ・30 文字以内で指定すること (S3 バケット名・IAM ロール名の上限のため)。"
  }
}

# 生成 (チャット) 側の基盤モデル ID。outputs.tf 側で global. プレフィックスを付けて
# グローバル推論プロファイル ID (global.anthropic.claude-sonnet-5) を組み立てる (07 と同じ)。
variable "base_model_id" {
  description = "チャット応答生成に使う Claude の基盤モデル ID (global プレフィックスなし)"
  type        = string
  default     = "anthropic.claude-sonnet-5"

  # global. の二重付与 (global.global.…) は apply が通って実行時にだけ失敗するため事前に弾く
  validation {
    condition     = !startswith(var.base_model_id, "global.")
    error_message = "base_model_id には global. プレフィックスを含めないこと (outputs.tf 側で付与する)。"
  }
}

# 埋め込み (ベクトル化) に使うモデル ID。取り込み時とクエリ時の両方で Knowledge Base が呼び出す。
# 取り込み後に変更するとベクトル空間が変わり既存インデックスが使えなくなるため、
# 変更時は Knowledge Base とインデックスを再作成して再取り込みする必要がある。
# 選択肢 (東京で提供あり・テキスト埋め込み対応):
#   amazon.titan-embed-text-v2:0 … $0.02/1M トークン。日本語対応。256/512/1024 次元。最安のため推奨
#   cohere.embed-multilingual-v3 … 約 $0.10/1M トークン。1024 次元固定
#   cohere.embed-v4:0            … 約 $0.12/1M トークン。多モーダル対応
# Nova Multimodal Embeddings ($0.14/1M) は東京未提供かつテキスト用途では Titan V2 より高価。
variable "embedding_model_id" {
  description = "Knowledge Base の埋め込みモデル ID"
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

# 埋め込みベクトルの次元数。Titan Text Embeddings V2 は 256 / 512 / 1024 から選べる。
# 大きいほど検索精度が上がるがベクトルストレージ容量 (= S3 Vectors 料金) が比例して増える。
# チュートリアルでは精度優先で 1024 (Titan V2 のデフォルト) を採用する。
# S3 Vectors インデックスの dimension と一致させる必要がある (s3_vectors.tf で参照)。
variable "embedding_dimensions" {
  description = "埋め込みベクトルの次元数 (Titan V2: 256/512/1024)"
  type        = number
  default     = 1024

  validation {
    condition     = contains([256, 512, 1024], var.embedding_dimensions)
    error_message = "embedding_dimensions は 256 / 512 / 1024 のいずれかを指定すること。"
  }
}

# 階層チャンクの親チャンク最大トークン数 (1〜8192)。
# 検索ヒットした子チャンクの代わりに親チャンクが Retrieve の結果として返るため、
# 生成モデルに渡す前後文脈の広さ (= 1 件あたりの入力トークン数) を決める。
# 注意: 階層チャンクでは親子関係がフィルタ不可メタデータとして保存されるため、
# 極端に大きな値にするとメタデータサイズ上限を超えて取り込みジョブが失敗する。
# 既定の 1500 は安全域。
variable "parent_chunk_max_tokens" {
  description = "階層チャンクの親チャンク最大トークン数"
  type        = number
  default     = 1500

  validation {
    condition     = var.parent_chunk_max_tokens >= 1 && var.parent_chunk_max_tokens <= 8192
    error_message = "parent_chunk_max_tokens は 1〜8192 の範囲で指定すること。"
  }
}

# 階層チャンクの子チャンク最大トークン数 (1〜8192、親より小さくする)。
# 実際に埋め込み・検索される粒度。規則文書の条・項 1 つ分に収まる程度に小さくすると精度が上がる。
variable "child_chunk_max_tokens" {
  description = "階層チャンクの子チャンク最大トークン数"
  type        = number
  default     = 300

  # 親 ≦ 子 のような矛盾値は AWS API 側 (apply 時) まで検出されないため事前に弾く
  validation {
    condition     = var.child_chunk_max_tokens >= 1 && var.child_chunk_max_tokens < var.parent_chunk_max_tokens
    error_message = "child_chunk_max_tokens は 1 以上かつ parent_chunk_max_tokens より小さくすること。"
  }
}

# 隣接する子チャンク間で重複させるトークン数。
# 条文が境界で分断されて意味が欠けるのを防ぐ。子チャンクの 20% 程度が目安。
variable "chunk_overlap_tokens" {
  description = "子チャンク間のオーバーラップトークン数"
  type        = number
  default     = 60

  validation {
    condition     = var.chunk_overlap_tokens >= 0 && var.chunk_overlap_tokens < var.child_chunk_max_tokens
    error_message = "chunk_overlap_tokens は 0 以上かつ child_chunk_max_tokens より小さくすること。"
  }
}

# データソース S3 バケットのオブジェクトを SSE-KMS で暗号化する場合の KMS キー ARN。
# 空文字 (デフォルト) の場合は SSE-S3 (AWS 管理キー・追加料金なし) を使う。
# 社内規則に高い機密性が求められる場合は CMK を指定する (KMS キー料金 $1/月 + API 料金が発生し、
# Knowledge Base のサービスロールへ kms:Decrypt 権限が自動で追加される)。
variable "kms_key_arn" {
  description = "データソース S3 バケットの SSE-KMS 用キー ARN (空なら SSE-S3)"
  type        = string
  default     = ""
}
