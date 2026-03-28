from fastapi import FastAPI, HTTPException, UploadFile, File, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager
from datetime import datetime
from bson import ObjectId
import json

from database import connect_db, close_db, get_database
from models import ConversationCreate, Message, MessageCreate, Citation
from ai import stream_response
from documents import (
    extract_text_and_pages,
    save_document,
    get_document_meta,
    get_document_raw,
    list_documents,
    list_documents_with_text,
)

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".txt"}
CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain; charset=utf-8",
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()
    yield
    await close_db()


app = FastAPI(title="AI Chat API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _serialize(doc: dict) -> dict:
    """Convert MongoDB _id → id string in-place."""
    doc["id"] = str(doc.pop("_id"))
    return doc


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

@app.get("/conversations")
async def list_conversations():
    db = get_database()
    docs = await db.conversations.find(
        {}, {"messages": 0}
    ).sort("updated_at", -1).to_list(100)
    return [_serialize(d) for d in docs]


@app.post("/conversations", status_code=201)
async def create_conversation(body: ConversationCreate):
    db = get_database()
    now = datetime.utcnow()
    doc = {
        "title": body.title,
        "messages": [],
        "created_at": now,
        "updated_at": now,
    }
    result = await db.conversations.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _serialize(doc)


@app.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str):
    db = get_database()
    doc = await db.conversations.find_one({"_id": ObjectId(conversation_id)})
    if not doc:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _serialize(doc)


@app.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: str):
    db = get_database()
    result = await db.conversations.delete_one({"_id": ObjectId(conversation_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Conversation not found")
    await db.documents.delete_many({"conversation_id": conversation_id})


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------

@app.post("/conversations/{conversation_id}/messages")
async def send_message(conversation_id: str, body: MessageCreate):
    db = get_database()
    conv = await db.conversations.find_one({"_id": ObjectId(conversation_id)})
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    user_msg = Message(role="user", content=body.content)
    await db.conversations.update_one(
        {"_id": ObjectId(conversation_id)},
        {
            "$push": {"messages": user_msg.model_dump()},
            "$set": {"updated_at": datetime.utcnow()},
        },
    )

    history = conv["messages"] + [user_msg.model_dump()]
    api_messages = [{"role": m["role"], "content": m["content"]} for m in history]

    if len(conv["messages"]) == 0:
        title = body.content[:60] + ("…" if len(body.content) > 60 else "")
        await db.conversations.update_one(
            {"_id": ObjectId(conversation_id)},
            {"$set": {"title": title}},
        )

    uploaded_docs = await list_documents_with_text(db, conversation_id)

    async def generate():
        full_response: list[str] = []
        all_citations: list[dict] = []

        async for event in stream_response(
            api_messages,
            uploaded_docs=uploaded_docs or None,
        ):
            if event["type"] == "text":
                full_response.append(event["content"])
                yield f"data: {json.dumps({'type': 'text', 'text': event['content']})}\n\n"

            elif event["type"] == "citations":
                # Resolve document_id for each citation
                for cit in event["citations"]:
                    match = next(
                        (d for d in uploaded_docs if d["filename"] == cit["document_title"]),
                        None,
                    )
                    cit["document_id"] = str(match["_id"]) if match else ""
                all_citations = event["citations"]
                yield f"data: {json.dumps({'type': 'citations', 'citations': all_citations})}\n\n"

        assistant_msg = Message(
            role="assistant",
            content="".join(full_response),
            citations=[Citation(**c) for c in all_citations],
        )
        await db.conversations.update_one(
            {"_id": ObjectId(conversation_id)},
            {
                "$push": {"messages": assistant_msg.model_dump()},
                "$set": {"updated_at": datetime.utcnow()},
            },
        )
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Documents — upload / list / detail / raw / delete
# ---------------------------------------------------------------------------

@app.post("/conversations/{conversation_id}/documents", status_code=201)
async def upload_document(conversation_id: str, file: UploadFile = File(...)):
    db = get_database()
    conv = await db.conversations.find_one({"_id": ObjectId(conversation_id)})
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")

    filename = file.filename or ""
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type '{ext}'. Allowed: .pdf, .docx, .txt",
        )

    data = await file.read()
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB)")

    text, page_map = extract_text_and_pages(filename, data)
    if not text:
        raise HTTPException(status_code=422, detail="Could not extract text from file")

    record = await save_document(db, conversation_id, filename, text, page_map, data)
    # Strip fields that must not be in the JSON response:
    # raw_bytes (bytes) cannot be JSON-serialised; text and page_map are too
    # large and are served via dedicated endpoints.
    for field in ("raw_bytes", "text", "page_map"):
        record.pop(field, None)
    record["conversation_id"] = str(record["conversation_id"])
    return _serialize(record)


@app.get("/conversations/{conversation_id}/documents")
async def get_documents(conversation_id: str):
    db = get_database()
    docs = await list_documents(db, conversation_id)
    for d in docs:
        d["conversation_id"] = str(d["conversation_id"])
    return [_serialize(d) for d in docs]


@app.get("/conversations/{conversation_id}/documents/{document_id}")
async def get_document_detail(conversation_id: str, document_id: str):
    """Returns document metadata + extracted text + page_map (no raw bytes)."""
    db = get_database()
    doc = await get_document_meta(db, conversation_id, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    doc["conversation_id"] = str(doc["conversation_id"])
    return _serialize(doc)


@app.get("/conversations/{conversation_id}/documents/{document_id}/raw")
async def serve_document_raw(conversation_id: str, document_id: str):
    """Serve the original uploaded file bytes."""
    db = get_database()
    doc = await get_document_raw(db, conversation_id, document_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    filename = doc["filename"]
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    content_type = CONTENT_TYPES.get(ext, "application/octet-stream")

    return Response(
        content=bytes(doc["raw_bytes"]),
        media_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@app.delete("/conversations/{conversation_id}/documents/{document_id}", status_code=204)
async def delete_document(conversation_id: str, document_id: str):
    db = get_database()
    result = await db.documents.delete_one(
        {"_id": ObjectId(document_id), "conversation_id": conversation_id}
    )
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Document not found")
