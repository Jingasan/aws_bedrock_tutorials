import { useState } from 'react'
import { useChat } from '@ai-sdk/react'
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
} from 'ai'
import './App.css'

//============================================================
// 接続先設定
// Mastra 側 (src/mastra/index.ts) の chatRoute({ path: '/chat/rules-agent' }) が公開する
// エンドポイントに接続する。
//============================================================

// チャット API の URL (VITE_CHAT_API_URL で上書き可能。既定は mastra dev のデフォルトポート 4111)
const CHAT_API_URL =
  import.meta.env.VITE_CHAT_API_URL ?? 'http://localhost:4111/chat/rules-agent'

// サーバーへ送信する履歴の最大メッセージ件数。
// Memory を使わず useChat が毎リクエストで履歴を送るため、会話が長くなっても
// 入力トークン数 (＝コスト) が無制限に増えないよう直近分に絞る (07 と同じ)。
// RAG では検索結果 (ツール出力) も履歴に含まれ 1 件あたりのサイズが大きいため、07 より少なめにする。
// 件数はユーザー発話とアシスタント発話 (ツール呼び出し込み) の合計のため、6 件 ≒ 直近 3 往復。
// 「先ほどの規則について詳しく」のような指示語が届かなくなる UX 上のトレードオフがあるので、
// コストより会話の連続性を優先する場合はこの値を増やす。
const MAX_SENT_MESSAGES = 6

// エージェント側 (rules-agent.ts) の tools のキー名。UIMessage のツールパート名と一致させる
const SEARCH_TOOL_NAME = 'searchRules'

//============================================================
// 型定義
// Mastra ツール (search-rules-tool.ts) の入出力スキーマに対応する。
// バックエンドとフロントエンドは tsconfig を分けているため型を共有せず、
// フロント側で必要な最小限の形だけを定義する。
//============================================================

/** searchRules ツールの入力 */
type SearchRulesInput = {
  query?: string
}

/** searchRules ツールが返す規則チャンク 1 件 */
type RuleChunk = {
  source: string
  page: number | null
  score: number | null
}

/** searchRules ツールの出力 */
type SearchRulesOutput = {
  results?: RuleChunk[]
}

/**
 * 検索ツールの呼び出し状況と参照した規則を表示するコンポーネント。
 *
 * ツールパートの state は input-streaming → input-available → output-available (または
 * output-error) と遷移する。検索中はクエリを、完了後は出典 (ファイル名・ページ) を一覧表示する。
 * isToolUIPart は静的ツール (tool-*) と動的ツール (dynamic-tool) の両方を返すため両型を受け付ける。
 */
function SearchToolPart({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  const input = part.input as SearchRulesInput | undefined
  const query = input?.query ?? ''

  if (part.state === 'output-error') {
    return (
      <p className="chat-tool chat-tool-error" role="alert">
        規則の検索に失敗しました: {part.errorText}
      </p>
    )
  }

  if (part.state !== 'output-available') {
    return <p className="chat-tool">規則を検索中… {query !== '' && <code>{query}</code>}</p>
  }

  const results = (part.output as SearchRulesOutput | undefined)?.results ?? []
  // 同じファイル・同じページの重複を除いて出典を一覧化する
  const sources = [...new Map(results.map((r) => [`${r.source}#${r.page ?? ''}`, r])).values()]

  return (
    <details className="chat-tool">
      <summary>
        規則を検索しました (<code>{query}</code> / {results.length} 件)
      </summary>
      {sources.length === 0 ? (
        <p>該当する規則は見つかりませんでした。</p>
      ) : (
        <ul>
          {sources.map((r) => (
            <li key={`${r.source}#${r.page ?? ''}`}>
              {r.source}
              {r.page !== null && ` (p.${r.page})`}
              {r.score !== null && <span className="chat-score"> score {r.score.toFixed(2)}</span>}
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

/**
 * Bedrock Knowledge Base に取り込んだ社内規則を検索して回答する AI チャット画面。
 *
 * useChat が Mastra の chatRoute エンドポイントへ全メッセージ履歴を POST し、
 * UI Message Stream 形式のストリーミング応答 (テキストとツール呼び出し) を messages に逐次反映する。
 */
function App() {
  // 入力欄の状態 (送信済みメッセージの状態管理は useChat に委譲する)
  const [input, setInput] = useState('')

  // messages: 会話履歴 / sendMessage: 送信 / status: ready・submitted・streaming・error
  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: CHAT_API_URL,
      // リクエストボディを組み立てる際に、送信する履歴を直近 MAX_SENT_MESSAGES 件に絞る
      prepareSendMessagesRequest: ({ id, messages, trigger, messageId }) => ({
        body: {
          id,
          trigger,
          messageId,
          messages: messages.slice(-MAX_SENT_MESSAGES),
        },
      }),
    }),
  })

  // 送信可能かどうか (ストリーミング中・送信中は多重送信を防ぐため無効化する)
  const isReady = status === 'ready' || status === 'error'

  /**
   * 入力内容をチャット API へ送信し、入力欄をクリアする。
   */
  const handleSubmit = () => {
    const question = input.trim()
    if (question === '' || !isReady) {
      return
    }
    sendMessage({ text: question })
    setInput('')
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <h1>社内規則 AI チャット</h1>
        <p>Bedrock Knowledge Base に取り込んだ社内規則を検索して回答します。</p>
      </header>

      <section className="chat-messages" aria-live="polite">
        {messages.length === 0 && (
          <p className="chat-empty">
            例:「年次有給休暇は何日付与されますか？」「在宅勤務の申請手続きを教えてください」
          </p>
        )}
        {messages.map((message) => (
          <article
            key={message.id}
            className={`chat-message ${message.role === 'user' ? 'user' : 'assistant'}`}
          >
            <span className="chat-role">
              {message.role === 'user' ? 'あなた' : 'Claude'}
            </span>
            <div className="chat-bubble">
              {/* UIMessage は複数パートを持つ。テキストと検索ツールの呼び出しを描画する */}
              {message.parts.map((part, index) => {
                if (part.type === 'text') {
                  return <span key={index}>{part.text}</span>
                }
                if (isToolUIPart(part) && getToolName(part) === SEARCH_TOOL_NAME) {
                  return <SearchToolPart key={index} part={part} />
                }
                return null
              })}
            </div>
          </article>
        ))}
        {status === 'submitted' && <p className="chat-status">応答を待っています…</p>}
        {error !== undefined && (
          <p className="chat-error" role="alert">
            エラーが発生しました: {error.message}
          </p>
        )}
      </section>

      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault()
          handleSubmit()
        }}
      >
        <input
          className="chat-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="社内規則について質問してください"
          aria-label="質問"
        />
        <button className="chat-send" type="submit" disabled={!isReady || input.trim() === ''}>
          送信
        </button>
      </form>
    </main>
  )
}

export default App
