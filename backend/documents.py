import io
from datetime import datetime

from bson import ObjectId
from pypdf import PdfReader
from docx import Document as DocxDocument

MAX_CHARS_PER_DOC = 100_000


# ---------------------------------------------------------------------------
# Text extraction
# ---------------------------------------------------------------------------

def extract_text_and_pages(filename: str, data: bytes) -> tuple[str, list[dict]]:
    """Return (extracted_text, page_map).

    page_map is a list of {page, start, end} dicts mapping character ranges to
    1-indexed page numbers.  Non-PDF types return an empty page_map.
    """
    name = filename.lower()
    if name.endswith(".pdf"):
        return _extract_pdf(data)
    if name.endswith(".docx"):
        return _extract_docx(data), []
    if name.endswith(".txt"):
        return data.decode("utf-8", errors="replace").strip(), []
    return "", []


def _extract_pdf(data: bytes) -> tuple[str, list[dict]]:
    reader = PdfReader(io.BytesIO(data))
    full_text = ""
    page_map: list[dict] = []
    for i, page in enumerate(reader.pages):
        page_text = page.extract_text() or ""
        start = len(full_text)
        full_text += page_text
        if i < len(reader.pages) - 1:
            full_text += "\n\n"
        page_map.append({"page": i + 1, "start": start, "end": len(full_text)})
    return full_text.strip(), page_map


def _extract_docx(data: bytes) -> str:
    doc = DocxDocument(io.BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs if p.text.strip()).strip()


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

async def save_document(
    db,
    conversation_id: str,
    filename: str,
    text: str,
    page_map: list[dict],
    raw_bytes: bytes,
) -> dict:
    truncated = text[:MAX_CHARS_PER_DOC]
    record = {
        "conversation_id": conversation_id,
        "filename": filename,
        "text": truncated,
        "char_count": len(truncated),
        "page_map": page_map,
        "raw_bytes": raw_bytes,
        "created_at": datetime.utcnow(),
    }
    result = await db.documents.insert_one(record)
    record["_id"] = result.inserted_id
    return record


async def get_document_meta(db, conversation_id: str, doc_id: str) -> dict | None:
    """Single document with text + page_map but without raw bytes."""
    return await db.documents.find_one(
        {"_id": ObjectId(doc_id), "conversation_id": conversation_id},
        {"raw_bytes": 0},
    )


async def get_document_raw(db, conversation_id: str, doc_id: str) -> dict | None:
    """Single document with raw_bytes (for file serving)."""
    return await db.documents.find_one(
        {"_id": ObjectId(doc_id), "conversation_id": conversation_id},
        {"raw_bytes": 1, "filename": 1},
    )


async def list_documents(db, conversation_id: str) -> list[dict]:
    """Metadata list — no text, no page_map, no raw bytes."""
    return await db.documents.find(
        {"conversation_id": conversation_id},
        {"text": 0, "page_map": 0, "raw_bytes": 0},
    ).to_list(None)


async def list_documents_with_text(db, conversation_id: str) -> list[dict]:
    """Full documents including text (for Claude context injection)."""
    return await db.documents.find(
        {"conversation_id": conversation_id},
        {"raw_bytes": 0},
    ).to_list(None)
