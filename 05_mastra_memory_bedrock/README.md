# 05. Mastra Memory 会話履歴永続化チャットスクリプト

[04_mastra_bedrock](../04_mastra_bedrock/README.md) と同じ「Claude Sonnet 5 との対話型ストリーミングチャット」で、会話履歴の管理を手動の `ModelMessage[]` 配列から Mastra の Memory 機能 ([`@mastra/memory`](https://mastra.ai/docs/memory/overview) + `@mastra/libsql`) に置き換えたチュートリアルです。履歴はローカルの SQLite ファイル (`memory.db`) に永続化されるため、**プロセスを再起動しても前回の会話の続きから再開できます**。

## 構成

- モデル: Claude Sonnet 5 (`global.anthropic.claude-sonnet-5`、グローバルルーティング)
- エンドポイント: bedrock-runtime (`https://bedrock-runtime.ap-northeast-1.amazonaws.com`)
- フレームワーク: `@mastra/core` の `Agent` + `@ai-sdk/amazon-bedrock/anthropic` (`bedrockAnthropic`)
- メモリ: `@mastra/memory` の `Memory` + `@mastra/libsql` の `LibSQLStore` (`memory.db` に永続化)
- 認証: AWS プロファイル `default` (`@aws-sdk/credential-providers` の `fromNodeProviderChain` で解決、SigV4 署名は SDK が自動処理)
- `terraform/`: InvokeModel / InvokeModelWithResponseStream 許可の IAM ポリシー (03/04 と同一権限)
- `src/`: TypeScript の対話型チャットスクリプト (Node.js 24 のネイティブ型ストリッピングで直接実行)

> **04 との違い (Memory)**: 04 は `ModelMessage[]` 配列を手動で push/pop し、毎ターン全履歴を `agent.stream(messages)` に渡していました。05 では `Agent` に `memory` を渡し、`agent.stream()` には**新しい質問文字列だけ**を渡して `memory: { thread, resource }` で会話スレッドを指定します。履歴の保存と、直近 `lastMessages` 件 (既定 10 件) のコンテキスト注入は Mastra が自動で行います。**stream に履歴配列を渡してはいけません** (Memory の注入と二重になります)。

> **thread と resource**: Memory は「resource (ユーザー) が所有する thread (会話)」単位で履歴を管理します。スレッドは初回ターンの正常完了時に自動作成されます。thread は所有者の resource に紐づくため、**別の resource から既存の thread は開けません** (`MEMORY_RESOURCE_ID` を変える場合は `MEMORY_THREAD_ID` もペアで変えてください)。また、**`resource` の指定を省略すると履歴が保存されません**。

> **エラーになったターンは保存されない**: Memory への保存はストリームの正常完了時にまとめて行われるため、レート制限やモデル ID 誤りなどでエラーになったターンは、ユーザーメッセージも含めて履歴に残りません (04 で手動で行っていた `messages.pop()` 相当が自動で成立します)。これは現行バージョン (`@mastra/core` 1.61) の内部実装に基づく挙動のため、バージョン更新時は再確認してください。

> **スコープ外**: 過去会話の意味検索 (semantic recall) と、会話から抽出した事実の構造化保持 (working memory) はどちらもデフォルト無効で、本チュートリアルでは扱いません。無効のままなら vector DB や埋め込みモデルの設定は不要です。スレッドタイトルの自動生成 (`generateTitle`) もデフォルト無効のため、履歴保存のための追加 LLM 呼び出し (追加コスト) は発生しません。

> **IAM は 03/04 と同一**: Memory はローカル SQLite への永続化で AWS リソースを使わないため、必要な権限は `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` のまま変わりません。

## 前提条件

1. AWS プロファイル `default` が設定済みであること (`aws sts get-caller-identity` で確認)
2. [Bedrock コンソールのモデルアクセス](https://console.aws.amazon.com/bedrock/home#/modelaccess) で Anthropic Claude Sonnet 5 が有効化されていること (Terraform では有効化できません)

## セットアップ

### 1. Terraform でリソースを作成

03 または 04 のポリシーをアタッチ済みであれば、権限は同一のためこの手順はスキップできます。

```bash
cd terraform
terraform init
terraform apply
```

作成されるリソース:

| リソース | 用途 |
|---|---|
| `aws_iam_policy.invoke_claude` | InvokeModel / InvokeModelWithResponseStream の呼び出し許可ポリシー |

実行ユーザーに Bedrock の呼び出し権限がない場合は、output の `invoke_policy_arn` のポリシーを対象の IAM ユーザー/ロールにアタッチしてください。

### 2. 依存パッケージのインストール

```bash
npm install
```

## 実行

```bash
npm run chat
```

`exit` / `quit` の入力または Ctrl+D で終了します。

### 永続化のデモ

1. `npm run chat` を起動し、名前や好きな話題を伝えてから `exit` で終了する
2. もう一度 `npm run chat` を起動すると、`既存スレッド "tutorial-thread" を再開します (これまでのメッセージ: N 件)。` と表示される
3. 「私の名前は何？」のように前回の内容を質問すると、履歴を踏まえて回答される

環境変数で挙動を変更できます:

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `BEDROCK_MODEL_ID` | `global.anthropic.claude-sonnet-5` | モデル ID (グローバル推論プロファイル ID) |
| `AWS_REGION` | `ap-northeast-1` | 接続先 bedrock-runtime エンドポイントのリージョン |
| `AWS_PROFILE` | `default` | AWS プロファイル名 |
| `MEMORY_THREAD_ID` | `tutorial-thread` | 会話スレッドの識別子 (変えると別の会話として開始) |
| `MEMORY_RESOURCE_ID` | `tutorial-user` | スレッドを所有するユーザーの識別子 (変える場合は thread もペアで変更) |

### 履歴のリセット

会話履歴をすべて消すには `memory.db` (と派生の `memory.db-shm` / `memory.db-wal` があればそれも) を削除するか、`MEMORY_THREAD_ID` を別の値にして新しいスレッドを開始します。

```bash
rm memory.db
```

## 型チェック

```bash
npm run typecheck
```
