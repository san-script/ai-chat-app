import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Document as PdfDoc, Page } from 'react-pdf'
import mammoth from 'mammoth'
import { getDocumentDetail, getDocumentRawUrl } from '../lib/api'
import type { Document, DocumentDetail, ActiveCitation } from '../lib/api'
import './DocumentViewer.css'

// Keep this outside the component
function normalise(s: string): string {
  return s
    .replace(/[\uf000-\uf8ff]/g, '') // strip private-use bullets like \uf0b7
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

interface Props {
  doc: Document
  conversationId: string
  citation: ActiveCitation | null
  onClose: () => void
}

type Tab = 'doc' | 'text'

export default function DocumentViewer({ doc, conversationId, citation, onClose }: Props) {
  const isPdf = doc.filename.toLowerCase().endsWith('.pdf')
  const isDocx = doc.filename.toLowerCase().endsWith('.docx')

  const [detail, setDetail] = useState<DocumentDetail | null>(null)
  const [htmlContent, setHtml] = useState<string | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setPage] = useState(1)
  const [tab, setTab] = useState<Tab>('doc')
  const [loading, setLoading] = useState(true)

  // FIX 1: pageKey forces <Page> to fully unmount+remount on every citation change,
  // guaranteeing customTextRenderer re-runs on the fresh text layer.
  // Without this, react-pdf caches the text layer and never re-runs the renderer.
  const [pageKey, setPageKey] = useState(0)

  const itemOffsetsRef = useRef<number[]>([])
  const pageTextRef = useRef('')
  const pageGlobalStartRef = useRef(0)
  const pageGlobalEndRef = useRef(Infinity)
  const [textVersion, setTextVersion] = useState(0)

  const rawUrl = getDocumentRawUrl(conversationId, doc.id)

  // Load document detail (text + page_map) and convert DOCX on open
  useEffect(() => {
    setLoading(true)
    setDetail(null)
    setHtml(null)
    setPage(1)

    getDocumentDetail(conversationId, doc.id)
      .then(d => { setDetail(d); setLoading(false) })
      .catch(() => setLoading(false))

    if (isDocx) {
      fetch(rawUrl)
        .then(r => r.arrayBuffer())
        .then(buf => mammoth.convertToHtml({ arrayBuffer: buf }))
        .then(r => setHtml(r.value))
        .catch(() => setHtml('<p><em>Could not render document.</em></p>'))
    }
  }, [doc.id, conversationId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Respond to citation changes: navigate page + force Page remount
  useEffect(() => {
    if (!citation) return

    itemOffsetsRef.current = []
    pageTextRef.current = ''

    if (isPdf && detail?.page_map?.length) {
      const entry = detail.page_map.find(
        e => citation.start_char_index >= e.start && citation.start_char_index < e.end
      )
      if (entry) {
        // Set global page boundaries so customTextRenderer can do offset math
        pageGlobalStartRef.current = entry.start
        pageGlobalEndRef.current = entry.end
        if (entry.page !== currentPage) {
          setPage(entry.page)
        } else {
          setPageKey(k => k + 1)
        }
      } else {
        // Citation starts before this page or page_map miss — use full page
        pageGlobalStartRef.current = 0
        pageGlobalEndRef.current = Infinity
        setPageKey(k => k + 1)
      }
    } else {
      pageGlobalStartRef.current = 0
      pageGlobalEndRef.current = Infinity
      setPageKey(k => k + 1)
    }

    setTimeout(() => {
      document.getElementById('doc-highlight')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 300)
  }, [citation, detail, isPdf]) // eslint-disable-line react-hooks/exhaustive-deps

  // Build cumulative offsets in normalised space once the page's text layer loads.
  // pageTextRef stores the normalised concatenation so matchIdx from indexOf aligns
  // with itemOffsetsRef values — both are in the same normalised character space.
  // handleGetText — store RAW offsets and RAW full text, never normalised
  const handleGetText = useCallback(
    (({ items }: { items: ({ str: string } | Record<string, unknown>)[] }) => {
      let offset = 0
      const offsets: number[] = []
      let full = ''
      for (const item of items) {
        offsets.push(offset)
        const s = typeof (item as { str?: string }).str === 'string'
          ? (item as { str: string }).str
          : ''
        full += s           // RAW — do not normalise here
        offset += s.length  // RAW length
      }
      itemOffsetsRef.current = offsets
      pageTextRef.current = full   // RAW page text
      setTextVersion(v => v + 1)
    }) as NonNullable<React.ComponentProps<typeof Page>['onGetTextSuccess']>,
    [],
  )

  // customTextRenderer — uses page_map global offsets, falls back to text search
  const customTextRenderer = useCallback(
    ({ str, itemIndex }: { str: string; itemIndex: number }) => {
      if (!citation || !str) return str

      const pt = pageTextRef.current  // RAW page text
      if (!pt) return str

      // ── Approach 1: use page_map global offsets (most accurate) ──────────────
      // pageGlobalStartRef is set in the citation useEffect from page_map
      const pageGlobalStart = pageGlobalStartRef.current
      const pageGlobalEnd = pageGlobalEndRef.current

      // Convert global citation range to page-local range
      const localStart = Math.max(0, citation.start_char_index - pageGlobalStart)
      const localEnd = Math.min(
        pageGlobalEnd - pageGlobalStart,
        citation.end_char_index - pageGlobalStart
      )

      // Check if citation overlaps this page at all
      const citationOverlapsPage =
        citation.start_char_index < pageGlobalEnd &&
        citation.end_char_index > pageGlobalStart

      if (citationOverlapsPage && localEnd > localStart) {
        const itemStart = itemOffsetsRef.current[itemIndex] ?? 0
        const itemEnd = itemStart + str.length  // RAW length

        if (itemEnd > localStart && itemStart < localEnd) {
          // Partial overlap: slice the raw str
          const os = Math.max(0, localStart - itemStart)
          const oe = Math.min(str.length, localEnd - itemStart)
          if (os === 0 && oe === str.length) {
            // Whole item highlighted
            return `<mark id="doc-highlight" style="background:#fbbf24;color:#1a1a1a;border-radius:3px;padding:0 1px">${str}</mark>`
          }
          return (
            str.slice(0, os) +
            `<mark id="doc-highlight" style="background:#fbbf24;color:#1a1a1a;border-radius:3px;padding:0 1px">${str.slice(os, oe)}</mark>` +
            str.slice(oe)
          )
        }
        return str
      }

      // ── Approach 2: text search fallback (when page_map is absent) ───────────
      const citedNorm = normalise(citation.cited_text)
      const ptNorm = normalise(pt)

      // Try first 8 words of cited text (handles cross-page citations better
      // than full match — finds the start of the citation on this page)
      const firstWords = citedNorm.split(' ').slice(0, 8).join(' ')
      let matchIdx = firstWords.length > 4 ? ptNorm.indexOf(firstWords) : -1

      // Also try last 8 words to catch citations that START before this page
      // but END on this page
      const lastWords = citedNorm.split(' ').slice(-8).join(' ')
      const lastIdx = lastWords.length > 4 ? ptNorm.indexOf(lastWords) : -1

      if (matchIdx === -1 && lastIdx === -1) return str

      // Determine highlight range in normalised coords
      const hlStart = matchIdx !== -1 ? matchIdx : 0
      const hlEnd = lastIdx !== -1
        ? lastIdx + lastWords.length
        : matchIdx + citedNorm.length

      // Map back to raw itemOffsets (normalised length ≈ raw length after
      // stripping only private-use chars — close enough for range check)
      const itemStart = itemOffsetsRef.current[itemIndex] ?? 0
      const itemEnd = itemStart + str.length

      if (itemEnd <= hlStart || itemStart >= hlEnd) return str

      return `<mark id="doc-highlight" style="background:#fbbf24;color:#1a1a1a;border-radius:3px;padding:0 1px">${str}</mark>`
    },
    [citation, textVersion], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // DOCX: inject <mark> around the cited passage in the HTML
  const docxHtml = useMemo(() => {
    if (!htmlContent) return ''
    if (!citation) return htmlContent
    const esc = citation.cited_text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return htmlContent.replace(
      new RegExp(esc, 'gi'),
      '<mark id="doc-highlight" style="background:#fbbf24;border-radius:2px;padding:0 2px">$&</mark>',
    )
  }, [htmlContent, citation])

  // ---- sub-renderers -------------------------------------------------------

  const renderPdf = () => (
    <div style={s.pdfWrap}>
      {citation && (
        <div style={s.banner}>
          <span style={s.bannerLabel}>📌 Cited passage</span>
          <span style={s.bannerText}>
            "{citation.cited_text.length > 140
              ? citation.cited_text.slice(0, 140) + '…'
              : citation.cited_text}"
          </span>
        </div>
      )}
      <div className="pdf-highlight-container">
        <PdfDoc file={rawUrl} onLoadSuccess={({ numPages: n }) => setNumPages(n)}>
          {/* FIX 1 applied: key includes currentPage + pageKey so <Page> fully
              remounts whenever the page changes OR a same-page citation arrives.
              This is the most critical fix — without it react-pdf's text layer
              cache prevents customTextRenderer from ever re-running. */}
          <Page
            key={`${currentPage}-${pageKey}`}
            pageNumber={currentPage}
            width={390}
            customTextRenderer={customTextRenderer}
            onGetTextSuccess={handleGetText}
          />
        </PdfDoc>
      </div>
      <div style={s.pageNav}>
        <button
          style={s.pageBtn}
          onClick={() => {
            itemOffsetsRef.current = []
            pageTextRef.current = ''
            setPageKey(k => k + 1)
            setPage(p => Math.max(1, p - 1))
          }}
          disabled={currentPage <= 1}
        >←</button>
        <span style={s.pageInfo}>{currentPage} / {numPages || '?'}</span>
        <button
          style={s.pageBtn}
          onClick={() => {
            itemOffsetsRef.current = []
            pageTextRef.current = ''
            setPageKey(k => k + 1)
            setPage(p => Math.min(numPages, p + 1))
          }}
          disabled={currentPage >= numPages}
        >→</button>
      </div>
    </div>
  )

  const renderDocx = () =>
    htmlContent == null ? (
      <div style={s.loading}>Converting…</div>
    ) : (
      <div style={s.htmlBody} dangerouslySetInnerHTML={{ __html: docxHtml }} />
    )

  const renderText = () => {
    if (!detail) return <div style={s.loading}>Loading text…</div>
    const text = detail.text
    if (!citation) return <pre style={s.pre}>{text}</pre>

    const start = Math.max(0, citation.start_char_index)
    const end = Math.min(text.length, citation.end_char_index)
    return (
      <pre style={s.pre}>
        {text.slice(0, start)}
        <mark id="doc-highlight" style={s.mark}>{text.slice(start, end)}</mark>
        {text.slice(end)}
      </pre>
    )
  }

  const showTextTab = isPdf || isDocx

  // ---- render --------------------------------------------------------------

  return (
    <aside style={s.panel}>
      {/* Header */}
      <div style={s.header}>
        <span style={s.title} title={doc.filename}>{doc.filename}</span>
        <div style={s.tabRow}>
          <button
            style={tab === 'doc' ? s.tabOn : s.tabOff}
            onClick={() => setTab('doc')}
          >
            {isPdf ? 'PDF' : isDocx ? 'Document' : 'Content'}
          </button>
          {showTextTab && (
            <button
              style={tab === 'text' ? s.tabOn : s.tabOff}
              onClick={() => {
                setTab('text')
                setTimeout(() => document.getElementById('doc-highlight')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60)
              }}
            >
              Text
            </button>
          )}
        </div>
        <button style={s.closeBtn} onClick={onClose} title="Close">✕</button>
      </div>

      {/* Body */}
      <div style={s.body}>
        {loading ? (
          <div style={s.loading}>Loading…</div>
        ) : tab === 'text' ? (
          renderText()
        ) : isPdf ? (
          renderPdf()
        ) : isDocx ? (
          renderDocx()
        ) : (
          renderText()
        )}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s: Record<string, React.CSSProperties> = {
  panel: {
    width: 430,
    minWidth: 430,
    borderLeft: '1px solid #2a2a2a',
    display: 'flex',
    flexDirection: 'column',
    background: '#111',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    borderBottom: '1px solid #2a2a2a',
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: '#e5e5e5',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tabRow: {
    display: 'flex',
    gap: 2,
  },
  tabOn: {
    background: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 5,
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  tabOff: {
    background: 'transparent',
    color: '#888',
    border: '1px solid #333',
    borderRadius: 5,
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    fontSize: 16,
    lineHeight: 1,
    padding: '2px 4px',
    flexShrink: 0,
  },
  body: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
  },
  loading: {
    color: '#666',
    fontSize: 13,
    padding: '24px',
    textAlign: 'center',
  },
  pdfWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '8px 0 12px',
    gap: 8,
  },
  banner: {
    width: '100%',
    padding: '8px 14px',
    background: '#1e293b',
    borderBottom: '1px solid #334155',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  bannerLabel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#93c5fd',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  bannerText: {
    fontSize: 12,
    color: '#cbd5e1',
    lineHeight: 1.5,
    fontStyle: 'italic',
  },
  pageNav: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '4px 0',
  },
  pageBtn: {
    background: '#1e293b',
    border: '1px solid #334155',
    color: '#93c5fd',
    borderRadius: 5,
    padding: '3px 10px',
    cursor: 'pointer',
    fontSize: 14,
  },
  pageInfo: {
    color: '#888',
    fontSize: 12,
    minWidth: 70,
    textAlign: 'center',
  },
  htmlBody: {
    padding: '16px 18px',
    color: '#d1d5db',
    fontSize: 13,
    lineHeight: 1.7,
  },
  pre: {
    margin: 0,
    padding: '16px 18px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 12,
    lineHeight: 1.7,
    color: '#c9d1d9',
    fontFamily: 'ui-monospace, monospace',
  },
  mark: {
    background: '#fbbf24',
    color: '#1a1a1a',
    borderRadius: 3,
    padding: '1px 2px',
  },
}