# Bedrock Knowledge Bases による社内規則 RAG チャット

社内規則の PDF を Amazon Bedrock Knowledge Bases に取り込み、07 の Mastra + React AI チャットから
検索・回答できるようにする RAG (Retrieval-Augmented Generation) のチュートリアル。

## 構成

```
[社内規則 PDF] --aws s3 sync--> [S3 バケット (データソース)]
                                      │ 取り込みジョブ (start-ingestion-job)
                                      │ PDF 解析 → 階層チャンク分割 → 埋め込み (Titan Text Embeddings V2)
                                      ▼
                         [Bedrock Knowledge Base] ──保存──> [S3 Vectors インデックス]
                                      ▲ Retrieve API (質問文を埋め込み → 類似チャンク検索)
                                      │
ブラウザ (React useChat) ──> mastra dev (chatRoute) ──> rulesAgent + searchRules ツール ──> Claude Sonnet 5 (global)
```

2 種類のモデルを役割分担で使う。

| 役割 | モデル | 動くタイミング | 役割 |
| --- | --- | --- | --- |
| 埋め込み | `amazon.titan-embed-text-v2:0` | PDF 取り込み時・質問検索時 | テキストをベクトル化して「意味の近さ」で検索できるようにする (文章は生成しない) |
| 生成 | `global.anthropic.claude-sonnet-5` | 会話のたび | 検索で得た規則の抜粋を読み、日本語の回答を組み立てる。検索ツールを呼ぶ判断もこちら |

- `terraform/` … Knowledge Base とその周辺リソース
  - `s3.tf` … PDF を置くデータソースバケット (パブリックアクセス全ブロック・暗号化・HTTPS 強制)
  - `s3_vectors.tf` … ベクトルストア (S3 Vectors バケット + インデックス)
  - `iam_kb_role.tf` … Knowledge Base のサービスロール (最小権限)
  - `knowledge_base.tf` … Knowledge Base 本体と S3 データソース (階層チャンク)
- `mastra_react/` … 07 をベースにしたアプリ
  - `src/mastra/tools/search-rules-tool.ts` … Retrieve API を呼ぶ Mastra ツール
  - `src/mastra/agents/rules-agent.ts` … 検索ツールを使って規則 QA を行うエージェント (Agentic RAG)
  - `src/App.tsx` … 検索状況と参照した規則 (ファイル名・ページ) を表示するチャット UI

## 設計判断

### ベクトルストアに S3 Vectors を採用

| ベクトルストア | 月額の目安 (数十 PDF) | 備考 |
| --- | --- | --- |
| **S3 Vectors** | 数十〜数百円 | ストレージ + クエリの従量課金のみ。レイテンシは 100ms〜1s 程度 |
| OpenSearch Serverless | 2〜3 万円〜 | 最小 OCU の常時課金が発生。低レイテンシ・高スループット向け |
| Aurora PostgreSQL (pgvector) | 数千円〜 | Serverless v2 でも待機コストあり。既に Aurora を運用している場合向け |

社内規則 QA のような低頻度・小規模ワークロードでは S3 Vectors が圧倒的に安価なため採用した。

### RAG 方式に Retrieve + ツール呼び出し (Agentic RAG) を採用

Knowledge Bases には検索と回答生成をまとめて行う `RetrieveAndGenerate` API もあるが、
生成モデルが KB 側に固定され、03〜07 で使ってきたグローバル推論プロファイル + ストリーミング +
`useChat` の構成を維持できない。`Retrieve` API を Mastra ツールとして Claude に渡すことで、

- 生成モデル・システムプロンプト・出力上限を Mastra 側で制御できる
- Claude が質問を検索向きの語彙に言い換えたり、必要なら再検索したりできる
- 出典 (ファイル名・ページ) をツール出力として UI に表示できる

### チャンク戦略に HIERARCHICAL を採用

規則文書は「章 > 条 > 項」の階層構造を持つため、小さな子チャンク (300 トークン) で精度良く検索し、
結果としては親チャンク (1500 トークン) を返して前後の文脈を Claude に渡す。値は `terraform/variables.tf` で調整できる。

## コスト面のガードレール

- 埋め込み: Titan V2 は $0.02/1M トークン。数十 PDF の取り込みでも数円〜数十円
- 生成: 実際のコスト支配要因。以下で上限を設ける
  - 検索 1 回の取得件数は既定 5 件・上限 10 件 (`search-rules-tool.ts`)
  - ツール呼び出しループは最大 5 ステップ (`src/mastra/index.ts` の `maxSteps`)
  - 応答の最大出力トークン数は 4096
  - フロントエンドから送る履歴は直近 6 件 (検索結果を含むため 07 より少なめ)

## 前提

- Node.js 22.13 以上、Terraform 1.10 以上、AWS Provider 6.62.0 以上、AWS CLI v2
- PDF はテキストレイヤーを持つこと (スキャン画像のみの PDF は既定パーサーで本文が抽出されず、
  取り込みは成功しても検索結果が空になる。その場合は `knowledge_base.tf` のコメントにある
  `parsing_configuration` を有効化する。別途推論コストが発生する)
- AWS 認証情報が標準チェーン (プロファイル等) で解決できること
- Bedrock コンソールで `Titan Text Embeddings V2` と `Claude Sonnet 5` のモデルアクセスが有効なこと
- 実行ユーザーに Claude 呼び出し (`bedrock:InvokeModel` / `InvokeModelWithResponseStream`)、
  検索 (`bedrock:Retrieve`)、取り込みジョブ管理 (`bedrock:StartIngestionJob` / `GetIngestionJob` /
  `ListIngestionJobs`)、PDF アップロード (`s3:ListBucket` / `PutObject` / `DeleteObject`、対象はデータソースバケット)
  の呼び出し権限があること (手動で用意)

## 手順

### 1. インフラを作成する

```bash
cd terraform
terraform init
terraform plan
terraform apply
```

### 2. PDF をアップロードして取り込む

PDF はリポジトリにコミットせず、ローカルのディレクトリから S3 へ直接同期する。

```bash
# PDF のアップロード (コマンドは terraform output upload_command でも確認できる)
aws s3 sync <PDF ディレクトリ> "s3://$(terraform output -raw documents_bucket_name)/" \
  --exclude '*' --include '*.pdf'

# 取り込みジョブの開始 (PDF を追加・更新・削除したら再実行する)
terraform output -raw ingestion_command | bash

# 取り込み状況の確認 (status が COMPLETE になるまで待つ。数十 PDF で数分程度)
aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id "$(terraform output -raw knowledge_base_id)" \
  --data-source-id "$(terraform output -raw data_source_id)" \
  --query 'ingestionJobSummaries[0].[status,statistics]'
```

### 3. アプリを起動する

```bash
cd ../mastra_react
npm install
cp .env.example .env
# .env の BEDROCK_KNOWLEDGE_BASE_ID に terraform output knowledge_base_id の値を設定する
```

ターミナルを 2 つ使い、バックエンドとフロントエンドをそれぞれ起動する。

```bash
# ターミナル 1: Mastra バックエンド (http://localhost:4111)
npm run dev:mastra

# ターミナル 2: Vite フロントエンド (http://localhost:5173)
npm run dev
```

ブラウザで http://localhost:5173 を開き、社内規則について質問する。
Claude が `searchRules` ツールで規則を検索し (UI に検索クエリと参照ファイルが表示される)、
検索結果に基づいて回答する。

### 4. 後片付け

```bash
cd ../terraform
terraform destroy
```

`force_destroy = true` と `data_deletion_policy = "DELETE"` により PDF (全バージョン) とベクトルも削除される。
本番環境に転用する場合は `force_destroy = false` にし、`prevent_destroy` の追加も検討すること。

## セキュリティ上の補足

- データソースバケット: パブリックアクセス全ブロック、HTTPS 強制、SSE-S3 (変数 `kms_key_arn` で SSE-KMS に切替可)、
  旧バージョンはライフサイクルで 30 日後に失効
- ベクトルバケット: バケットポリシーで Knowledge Base サービスロールと Terraform 実行者以外のアクセスを拒否 (多層防御)。
  Terraform を別のプリンシパルで実行するようになった場合は、旧プリンシパルで先に `terraform apply` してポリシーを更新すること
- AWS 認証情報を扱うのは `mastra dev` サーバー (Node) のみで、ブラウザには露出しない

## 環境変数 (mastra_react/.env)

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `AWS_PROFILE` | `default` | 認証情報の解決に使う AWS プロファイル名 |
| `AWS_REGION` | `ap-northeast-1` | Knowledge Base / bedrock-runtime のリージョン |
| `BEDROCK_MODEL_ID` | `global.anthropic.claude-sonnet-5` | 回答生成に使うモデル (グローバル推論プロファイル) |
| `BEDROCK_KNOWLEDGE_BASE_ID` | (必須) | 検索対象の Knowledge Base ID (`terraform output knowledge_base_id`) |
| `VITE_CHAT_API_URL` | `http://localhost:4111/chat/rules-agent` | フロントエンドが接続するチャット API |

## 検証コマンド

```bash
# アプリ
cd mastra_react
npm run typecheck  # tsc -b (app / node / mastra の 3 プロジェクト)
npm run lint       # oxlint

# インフラ
cd terraform
terraform fmt -check -recursive
terraform validate
```
