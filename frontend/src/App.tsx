import { useState, useEffect, useRef, FormEvent } from 'react'
import {
  listConversations,
  createConversation,
  getConversation,
  deleteConversation,
  uploadDocument,
  listDocuments,
  deleteDocument,
} from './lib/api'
import type { Conversation, Document, MessageCitation, ActiveCitation } from './lib/api'
import { useChat } from './hooks/useChat'
import DocumentViewer from './components/DocumentViewer'

export default function App() {
  const [conversations, setConversations] = useState<Omit<Conversation, 'messages'>[]>([])
  const [activeId, setActiveId]           = useState<string | null>(null)
  const [input, setInput]                 = useState('')
  const [documents, setDocuments]         = useState<Document[]>([])
  const [uploading, setUploading]         = useState(false)
  const [uploadError, setUploadError]     = useState<string | null>(null)

  // Viewer state
  const [viewerDoc, setViewerDoc]           = useState<Document | null>(null)
  const [viewerCitation, setViewerCitation] = useState<ActiveCitation | null>(null)

  const bottomRef  = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { messages, streaming, error, send, setMessages, clearError } = useChat()

  useEffect(() => {
    listConversations().then(setConversations).catch(console.error)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function handleSelectConversation(id: string) {
    clearError(); setUploadError(null)
    const conv = await getConversation(id)
    setActiveId(id)
    setMessages(conv.messages)
    const docs = await listDocuments(id)
    setDocuments(docs)
    setViewerDoc(null); setViewerCitation(null)
  }

  async function handleNewConversation() {
    const conv = await createConversation()
    setConversations(prev => [conv, ...prev])
    setActiveId(conv.id)
    setMessages([]); setDocuments([])
    clearError(); setUploadError(null)
    setViewerDoc(null); setViewerCitation(null)
  }

  async function handleDeleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    await deleteConversation(id)
    setConversations(prev => prev.filter(c => c.id !== id))
    if (activeId === id) {
      setActiveId(null); setMessages([]); setDocuments([])
      setViewerDoc(null); setViewerCitation(null)
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !activeId) return
    setUploading(true); setUploadError(null)
    try {
      const doc = await uploadDocument(activeId, file)
      setDocuments(prev => [...prev, doc])
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleDeleteDocument(docId: string) {
    if (!activeId) return
    await deleteDocument(activeId, docId)
    setDocuments(prev => prev.filter(d => d.id !== docId))
    if (viewerDoc?.id === docId) { setViewerDoc(null); setViewerCitation(null) }
  }

  function handleViewDoc(doc: Document) {
    setViewerDoc(doc); setViewerCitation(null)
  }

  function handleCitationClick(cit: MessageCitation) {
    const doc = documents.find(d => d.id === cit.document_id)
    if (!doc) return
    setViewerDoc(doc)
    setViewerCitation({
      cited_text: cit.cited_text,
      start_char_index: cit.start_char_index,
      end_char_index: cit.end_char_index,
    })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!input.trim() || !activeId || streaming) return
    const text = input.trim()
    setInput('')
    await send(activeId, text)
    const updated = await listConversations()
    setConversations(updated)
  }

  return (
    <div style={s.layout}>
      {/* ── Sidebar ─────────────────────────────────────── */}
      <aside style={s.sidebar}>
        <button style={s.newBtn} onClick={handleNewConversation}>+ New chat</button>
        <ul style={s.convList}>
          {conversations.map(c => (
            <li
              key={c.id}
              style={{ ...s.convItem, background: c.id === activeId ? '#2a2a2a' : 'transparent' }}
              onClick={() => handleSelectConversation(c.id)}
            >
              <span style={s.convTitle}>{c.title}</span>
              <button style={s.iconBtn} onClick={e => handleDeleteConversation(c.id, e)}>×</button>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Main + Viewer ────────────────────────────────── */}
      <div style={s.center}>

        {/* Chat panel */}
        <main style={s.main}>
          {!activeId ? (
            <div style={s.empty}>Select a conversation or start a new one.</div>
          ) : (
            <>
              {/* Messages */}
              <div style={s.messages}>
                {messages.length === 0 && documents.length > 0 && (
                  <div style={s.hint}>
                    {documents.length} document{documents.length > 1 ? 's' : ''} attached —
                    ask anything about {documents.length > 1 ? 'them' : 'it'}.
                  </div>
                )}

                {messages.map((m, i) => (
                  <div key={i} style={s.msgGroup}>
                    <div
                      style={{
                        ...s.bubble,
                        alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                        background: m.role === 'user' ? '#2563eb' : '#1e1e1e',
                      }}
                    >
                      <pre style={s.msgText}>{m.content}</pre>
                    </div>

                    {/* Citation chips */}
                    {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
                      <div style={s.citationRow}>
                        {m.citations.map((cit, ci) => (
                          <button
                            key={ci}
                            style={s.citChip}
                            onClick={() => handleCitationClick(cit)}
                            title={cit.cited_text}
                          >
                            <span style={s.citIcon}>📎</span>
                            <span style={s.citLabel}>
                              {cit.document_title.length > 22
                                ? cit.document_title.slice(0, 22) + '…'
                                : cit.document_title}
                            </span>
                            <span style={s.citArrow}>↗</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                {error && <div style={s.errBanner}>{error}</div>}
                <div ref={bottomRef} />
              </div>

              {/* Document chips */}
              <div style={s.docPanel}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.docx,.txt"
                  style={{ display: 'none' }}
                  onChange={handleFileChange}
                />
                <button
                  style={s.attachBtn}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? 'Uploading…' : '＋ Attach file'}
                </button>

                {documents.map(d => (
                  <span
                    key={d.id}
                    style={{
                      ...s.docChip,
                      outline: viewerDoc?.id === d.id ? '1px solid #3b82f6' : 'none',
                    }}
                  >
                    <button
                      style={s.docChipBtn}
                      onClick={() => handleViewDoc(d)}
                      title={`View ${d.filename}`}
                    >
                      📄 <span style={s.docName}>{d.filename}</span>
                      <span style={s.docSize}>{Math.round(d.char_count / 1000)}k</span>
                    </button>
                    <button style={s.docRemove} onClick={() => handleDeleteDocument(d.id)}>×</button>
                  </span>
                ))}

                {uploadError && <span style={s.uploadErr}>{uploadError}</span>}
              </div>

              {/* Input */}
              <form style={s.inputRow} onSubmit={handleSubmit}>
                <textarea
                  style={s.textarea}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSubmit(e as unknown as FormEvent)
                    }
                  }}
                  placeholder={
                    documents.length > 0
                      ? 'Ask a question about your documents…'
                      : 'Message… (Enter to send, Shift+Enter for newline)'
                  }
                  rows={3}
                  disabled={streaming}
                />
                <button
                  style={{ ...s.sendBtn, opacity: streaming || !input.trim() ? 0.5 : 1 }}
                  type="submit"
                  disabled={streaming || !input.trim()}
                >
                  {streaming ? '…' : 'Send'}
                </button>
              </form>
            </>
          )}
        </main>

        {/* Document Viewer panel */}
        {viewerDoc && activeId && (
          <DocumentViewer
            doc={viewerDoc}
            conversationId={activeId}
            citation={viewerCitation}
            onClose={() => { setViewerDoc(null); setViewerCitation(null) }}
          />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s: Record<string, React.CSSProperties> = {
  layout: {
    display: 'flex',
    height: '100vh',
    background: '#141414',
    color: '#e5e5e5',
    fontFamily: 'system-ui, sans-serif',
    overflow: 'hidden',
  },
  sidebar: {
    width: 260,
    minWidth: 260,
    borderRight: '1px solid #2a2a2a',
    display: 'flex',
    flexDirection: 'column',
    padding: '12px 8px',
    gap: 8,
    overflowY: 'auto',
  },
  center: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  newBtn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    padding: '8px 12px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
  convList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  convItem: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    gap: 6,
  },
  convTitle: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 14,
  },
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    fontSize: 16,
    lineHeight: 1,
    padding: '0 2px',
    flexShrink: 0,
  },
  empty: {
    margin: 'auto',
    color: '#555',
    fontSize: 15,
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '24px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  hint: {
    alignSelf: 'center',
    color: '#888',
    fontSize: 13,
    background: '#1e1e1e',
    padding: '6px 14px',
    borderRadius: 20,
    marginBottom: 8,
  },
  msgGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    marginBottom: 8,
  },
  bubble: {
    maxWidth: '72%',
    borderRadius: 10,
    padding: '10px 14px',
  },
  msgText: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 14,
    lineHeight: 1.6,
    fontFamily: 'inherit',
  },
  citationRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 6,
    paddingLeft: 4,
  },
  citChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 20,
    padding: '3px 10px 3px 8px',
    cursor: 'pointer',
    fontSize: 12,
    color: '#93c5fd',
    transition: 'background 0.15s',
  },
  citIcon: { fontSize: 12 },
  citLabel: {
    maxWidth: 160,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  citArrow: { fontSize: 11, opacity: 0.7 },
  errBanner: {
    color: '#f87171',
    fontSize: 13,
    padding: '8px 12px',
    background: '#2a1a1a',
    borderRadius: 6,
  },
  docPanel: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    borderTop: '1px solid #2a2a2a',
    minHeight: 44,
  },
  attachBtn: {
    background: '#1e293b',
    color: '#93c5fd',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  docChip: {
    display: 'inline-flex',
    alignItems: 'center',
    background: '#1e293b',
    border: '1px solid #334155',
    borderRadius: 6,
    fontSize: 12,
    maxWidth: 200,
  },
  docChipBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    background: 'transparent',
    border: 'none',
    color: '#cbd5e1',
    cursor: 'pointer',
    padding: '3px 6px 3px 8px',
    fontSize: 12,
  },
  docName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 120,
  },
  docSize: { color: '#64748b', flexShrink: 0, fontSize: 11 },
  docRemove: {
    background: 'transparent',
    border: 'none',
    borderLeft: '1px solid #334155',
    color: '#64748b',
    cursor: 'pointer',
    fontSize: 15,
    padding: '0 7px',
    alignSelf: 'stretch',
    display: 'flex',
    alignItems: 'center',
  },
  uploadErr: { color: '#f87171', fontSize: 12 },
  inputRow: {
    display: 'flex',
    gap: 8,
    padding: '12px 16px',
    borderTop: '1px solid #2a2a2a',
    alignItems: 'flex-end',
  },
  textarea: {
    flex: 1,
    background: '#1e1e1e',
    border: '1px solid #333',
    borderRadius: 8,
    color: '#e5e5e5',
    padding: '10px 12px',
    fontSize: 14,
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
  },
  sendBtn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 18px',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
}
