#============================================================
# Lambda 実行ロール (Guardrail 必須)
# agent/ を将来 Lambda で動かす際の実行ロール。IAM 条件キー bedrock:GuardrailIdentifier を使い、
# 「Terraform 管理の Guardrail バージョンをアタッチした呼び出しだけ」を許可し、Guardrail 無しの
# モデル呼び出しは明示的に拒否する。これにより、アプリ側の設定ミスや改変で guardrailConfig が
# 外れても LLM を素で呼び出せない。Lambda 関数本体は作成しない (ロールのみ)。
# https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions-id.html
#
# 制約 (AWS ドキュメントの Limitations):
#   - このロールは Bedrock Agents (InvokeAgent / InvokeInlineAgent) や Knowledge Bases の RetrieveAndGenerate と
#     併用できない (内部の InvokeModel に Guardrail が付かず AccessDenied になる)。08 のような KB 連携は Retrieve API のみ使うこと
#   - Guardrail の入力タグ (guardContent) で入力側の評価範囲は呼び出し側が狭められる。出力側の評価は常に適用される
#   - 信頼ポリシーの aws:SourceArn / aws:SourceAccount は Lambda 関数を実際に作成して AssumeRole が成功することを確認すること
#     (本チュートリアルは関数を作らないため未検証。SourceArn はバージョン/エイリアス無しの関数 ARN 形式)
#============================================================

locals {
  # bedrock:GuardrailIdentifier 条件キーの値。":<version>" を付けると特定バージョンのみ一致し、
  # DRAFT や他バージョンでの呼び出しは許可されない。バージョン再発行時は同じ apply でこの値も更新されるため、
  # アプリ側の BEDROCK_GUARDRAIL_VERSION を新バージョンへ更新するまでは旧バージョン指定の呼び出しが AccessDenied になる
  # (任意の番号付きバージョンを許可したい場合は ArnLike で "<guardrail_arn>:*" にする)
  guardrail_identifier_condition_value = "${aws_bedrock_guardrail.chat.guardrail_arn}:${aws_bedrock_guardrail_version.chat.version}"

  # 推論プロファイル ID か In-Region の基盤モデル ID かを、既知の Geo / Global プレフィックスの許可リストで判定する
  # (meta. / cohere. などベンダープレフィックスの基盤モデル ID を誤判定しないよう、汎用パターンは使わない)
  model_is_inference_profile = can(regex("^(us|eu|apac|global|jp|au|ca|uk|us-gov)\\.", var.model_id))

  # 推論プロファイル使用時の Resource。プロファイル ARN に加えて、転送先リージョンの基盤モデル ARN も必要になる。
  # 転送先は AWS 側で変わり得るため基盤モデル側はリージョンをワイルドカードにする (global.* ではリージョン空の ARN も含む)
  lambda_inference_profile_resources = [
    "arn:aws:bedrock:${var.aws_region}:${data.aws_caller_identity.current.account_id}:inference-profile/${var.model_id}",
    "arn:aws:bedrock:*::foundation-model/${trimprefix(var.model_id, "${split(".", var.model_id)[0]}.")}",
  ]

  # In-Region モデル使用時の Resource (基盤モデル ARN 1 本に絞る)
  lambda_in_region_model_resources = [
    "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.model_id}",
  ]

  # モデル呼び出しの Resource
  lambda_invoke_model_resources = local.model_is_inference_profile ? local.lambda_inference_profile_resources : local.lambda_in_region_model_resources
}

# Lambda が引き受ける実行ロール
resource "aws_iam_role" "lambda_guardrail" {
  # ロール名 (IAM ロール名は最大 64 文字)
  name = "${var.project_name}-lambda-role"
  # ロールの説明
  description = "Lambda execution role that can invoke Bedrock models only with the tutorial guardrail attached"

  # 信頼ポリシー。Lambda サービスからの AssumeRole を、自アカウントかつ指定接頭辞の関数に限定する
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowLambdaAssume"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action = "sts:AssumeRole"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = data.aws_caller_identity.current.account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.lambda_function_name_prefix}*"
          }
        }
      }
    ]
  })
}

# Bedrock 呼び出し権限 (Guardrail 必須)
resource "aws_iam_role_policy" "lambda_bedrock" {
  # インラインポリシー名
  name = "invoke-model-with-guardrail"
  role = aws_iam_role.lambda_guardrail.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Terraform 管理の Guardrail バージョンがアタッチされた呼び出しだけを許可する。
        # Converse / ConverseStream も IAM 上は InvokeModel / InvokeModelWithResponseStream として評価される
        Sid    = "InvokeModelOnlyWithGuardrail"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = local.lambda_invoke_model_resources
        Condition = {
          StringEquals = {
            "bedrock:GuardrailIdentifier" = local.guardrail_identifier_condition_value
          }
        }
      },
      {
        # 指定の Guardrail・バージョン以外での呼び出しを明示的に拒否する。
        # StringNotEquals は条件キーが存在しない (Guardrail 未指定) 場合も真になるため、未指定・別 Guardrail・DRAFT・
        # 旧バージョンのすべてが拒否される。他のポリシーで広い Allow が付与されても確実に効くよう Deny を置く (AWS 公式例と同じ形)
        Sid    = "DenyInvokeModelWithoutTutorialGuardrail"
        Effect = "Deny"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = "*"
        Condition = {
          StringNotEquals = {
            "bedrock:GuardrailIdentifier" = local.guardrail_identifier_condition_value
          }
        }
      },
      {
        # Guardrail の適用権限。Standard tier はクロスリージョン推論で評価されるため転送先リージョンのプロファイルも必要
        Sid      = "ApplyGuardrail"
        Effect   = "Allow"
        Action   = ["bedrock:ApplyGuardrail"]
        Resource = concat([aws_bedrock_guardrail.chat.guardrail_arn], local.guardrail_profile_arns)
      },
    ]
  })
}

# CloudWatch Logs への書き込み権限 (Lambda の標準ログ出力)。対象ロググループを接頭辞に一致する関数のものに限定する
resource "aws_iam_role_policy" "lambda_logs" {
  # インラインポリシー名
  name = "write-cloudwatch-logs"
  role = aws_iam_role.lambda_guardrail.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteLambdaLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ]
        Resource = [
          "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.lambda_function_name_prefix}*",
        ]
      }
    ]
  })
}
