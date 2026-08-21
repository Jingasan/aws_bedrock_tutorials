# 01. ConverseStream API 対話型チャットスクリプト

AWS Bedrock の ConverseStream API を使い、ローカルの Node.js から Claude に質問して回答をストリーミング表示する対話型チャットスクリプトです。

## 構成

- モデル: Claude Sonnet 4.6 (`anthropic.claude-sonnet-4-6`)
- リージョン: 東京 (`ap-northeast-1`) + 日本国内クロスリージョン推論プロファイル (`jp.` プレフィックス、東京・大阪ルーティング)
- 認証: AWS プロファイル `default`
- `terraform/`: アプリケーション推論プロファイル (コスト配分タグ付き) と呼び出し許可の IAM ポリシー
- `src/`: TypeScript の対話型チャットスクリプト (Node.js 24 のネイティブ型ストリッピングで直接実行)

> **補足**: ConverseStream API (従来型の Bedrock 統合) で使える最新の Claude は Opus 4.6 / Sonnet 4.6 世代までです。Claude 5 系 (Opus 5 / Sonnet 5 など) は Messages API ベースの新しい Bedrock エンドポイント経由のみで提供されています。

## 前提条件

1. AWS プロファイル `default` が設定済みであること (`aws sts get-caller-identity` で確認)
2. [Bedrock コンソールのモデルアクセス](https://console.aws.amazon.com/bedrock/home#/modelaccess) で Anthropic Claude Sonnet 4.6 が有効化されていること (Terraform では有効化できません)

## セットアップ

### 1. Terraform でリソースを作成

```bash
cd terraform
terraform init
terraform apply
```

作成されるリソース:

| リソース | 用途 |
|---|---|
| `aws_bedrock_inference_profile.chat` | コスト配分タグ付きのアプリケーション推論プロファイル |
| `aws_iam_policy.invoke_claude` | Converse/ConverseStream の呼び出し許可ポリシー |

実行ユーザーに Bedrock の呼び出し権限がない場合は、output の `invoke_policy_arn` のポリシーを対象の IAM ユーザー/ロールにアタッチしてください。

### 2. 依存パッケージのインストール

```bash
npm install
```

## 実行

```bash
# システム定義の jp プロファイルで実行 (デフォルト)
npm run chat

# Terraform で作成したアプリケーション推論プロファイル経由で実行 (コスト追跡したい場合)
BEDROCK_MODEL_ID=$(terraform -chdir=terraform output -raw inference_profile_arn) npm run chat
```

`exit` / `quit` の入力または Ctrl+D で終了します。会話履歴はプロセス内で保持され、文脈を踏まえた連続質問ができます。

環境変数で挙動を変更できます:

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `BEDROCK_MODEL_ID` | `jp.anthropic.claude-sonnet-4-6` | modelId (推論プロファイル ID / ARN も可) |
| `AWS_REGION` | `ap-northeast-1` | 呼び出し先リージョン |
| `AWS_PROFILE` | `default` | AWS プロファイル名 |

## 型チェック

```bash
npm run typecheck
```
