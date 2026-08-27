import { useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import './App.css'

//============================================================
// 接続先設定
// Mastra 側 (src/mastra/index.ts) の chatRoute({ path: '/chat/:agentId' }) が公開する
// エンドポイントに接続する。:agentId はエージェント定義 (chat-agent.ts) の id。
//============================================================

// チャット API の URL (VITE_CHAT_API_URL で上書き可能。既定は mastra dev のデフォルトポート 4111)
const CHAT_API_URL =
  import.meta.env.VITE_CHAT_API_URL ?? 'http://localhost:4111/chat/chat-agent'

// サーバーへ送信する履歴の最大メッセージ件数。
// 本章は Memory を使わず useChat が毎リクエストで履歴を送るため、会話が長くなっても
// 入力トークン数 (＝コスト) が無制限に増えないよう直近分に絞る (05/06 の
// Memory lastMessages: 10 に相当するガードレール)。UI 上の表示は全件保持される。
const MAX_SENT_MESSAGES = 10

/**
 * Bedrock 上の Claude Sonnet 5 と会話する AI チャット画面。
 *
 * useChat が Mastra の chatRoute エンドポイントへ全メッセージ履歴を POST し、
 * UI Message Stream 形式のストリーミング応答を messages に逐次反映する。
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
        <h1>Mastra × React AI チャット</h1>
        <p>Amazon Bedrock の Claude Sonnet 5 と会話できます。</p>
      </header>

      <section className="chat-messages" aria-live="polite">
        {messages.length === 0 && (
          <p className="chat-empty">質問を入力して会話を始めてください。</p>
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
              {/* UIMessage は複数パートを持つ。本章はテキストのみを描画する */}
              {message.parts.map((part, index) =>
                part.type === 'text' ? <span key={index}>{part.text}</span> : null,
              )}
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
          placeholder="質問を入力してください"
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
