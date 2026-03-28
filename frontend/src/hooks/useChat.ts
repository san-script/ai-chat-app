import { useState, useCallback } from "react"
import type { Message, MessageCitation } from "../lib/api"
import { sendMessage } from "../lib/api"

interface UseChatState {
  messages: Message[]
  streaming: boolean
  error: string | null
}

interface UseChatActions {
  send: (conversationId: string, content: string) => Promise<void>
  setMessages: (messages: Message[]) => void
  clearError: () => void
}

export function useChat(): UseChatState & UseChatActions {
  const [messages, setMessages] = useState<Message[]>([])
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = useCallback(async (conversationId: string, content: string) => {
    const userMsg: Message = {
      role: "user",
      content,
      created_at: new Date().toISOString(),
    }

    setMessages(prev => [...prev, userMsg])
    setStreaming(true)
    setError(null)

    const assistantMsg: Message = {
      role: "assistant",
      content: "",
      created_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, assistantMsg])

    try {
      for await (const event of sendMessage(conversationId, content)) {
        if (event.type === "text") {
          setMessages(prev => {
            const updated = [...prev]
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              content: updated[updated.length - 1].content + event.text,
            }
            return updated
          })
        } else if (event.type === "citations") {
          const citations: MessageCitation[] = event.citations
          setMessages(prev => {
            const updated = [...prev]
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              citations,
            }
            return updated
          })
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
      setMessages(prev => prev.slice(0, -1))
    } finally {
      setStreaming(false)
    }
  }, [])

  return {
    messages,
    streaming,
    error,
    send,
    setMessages,
    clearError: () => setError(null),
  }
}
