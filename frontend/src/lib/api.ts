const BASE = "/conversations"

export interface Message {
  role: "user" | "assistant"
  content: string
  created_at: string
  citations?: MessageCitation[]
}

export interface MessageCitation {
  document_id: string
  document_title: string
  cited_text: string
  start_char_index: number
  end_char_index: number
  document_index: number
}

export interface ActiveCitation {
  cited_text: string
  start_char_index: number
  end_char_index: number
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  created_at: string
  updated_at: string
}

export interface Document {
  id: string
  conversation_id: string
  filename: string
  char_count: number
  created_at: string
}

export interface PageMapEntry {
  page: number
  start: number
  end: number
}

export interface DocumentDetail extends Document {
  text: string
  page_map: PageMapEntry[]
}

// ---- Conversations --------------------------------------------------------

export async function listConversations(): Promise<Omit<Conversation, "messages">[]> {
  const res = await fetch(BASE)
  if (!res.ok) throw new Error("Failed to load conversations")
  return res.json()
}

export async function createConversation(title = "New Conversation"): Promise<Conversation> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error("Failed to create conversation")
  return res.json()
}

export async function getConversation(id: string): Promise<Conversation> {
  const res = await fetch(`${BASE}/${id}`)
  if (!res.ok) throw new Error("Failed to load conversation")
  return res.json()
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, { method: "DELETE" })
  if (!res.ok) throw new Error("Failed to delete conversation")
}

// ---- Messages (SSE) -------------------------------------------------------

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "citations"; citations: MessageCitation[] }

export async function* sendMessage(
  conversationId: string,
  content: string,
): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${BASE}/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  if (!res.ok || !res.body) throw new Error("Failed to send message")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue
      const data = line.slice(6)
      if (data === "[DONE]") return
      try {
        const parsed = JSON.parse(data) as { type: string; text?: string; citations?: MessageCitation[] }
        if (parsed.type === "text" && parsed.text !== undefined) {
          yield { type: "text", text: parsed.text }
        } else if (parsed.type === "citations" && parsed.citations) {
          yield { type: "citations", citations: parsed.citations }
        }
      } catch {
        // malformed event — skip
      }
    }
  }
}

// ---- Documents ------------------------------------------------------------

export async function uploadDocument(conversationId: string, file: File): Promise<Document> {
  const form = new FormData()
  form.append("file", file)
  const res = await fetch(`${BASE}/${conversationId}/documents`, {
    method: "POST",
    body: form,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { detail?: string }).detail ?? "Failed to upload document")
  }
  return res.json()
}

export async function listDocuments(conversationId: string): Promise<Document[]> {
  const res = await fetch(`${BASE}/${conversationId}/documents`)
  if (!res.ok) throw new Error("Failed to list documents")
  return res.json()
}

export async function getDocumentDetail(
  conversationId: string,
  documentId: string,
): Promise<DocumentDetail> {
  const res = await fetch(`${BASE}/${conversationId}/documents/${documentId}`)
  if (!res.ok) throw new Error("Failed to load document detail")
  return res.json()
}

export function getDocumentRawUrl(conversationId: string, documentId: string): string {
  return `${BASE}/${conversationId}/documents/${documentId}/raw`
}

export async function deleteDocument(conversationId: string, documentId: string): Promise<void> {
  const res = await fetch(`${BASE}/${conversationId}/documents/${documentId}`, {
    method: "DELETE",
  })
  if (!res.ok) throw new Error("Failed to delete document")
}
