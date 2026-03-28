from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class Message(BaseModel):
    role: str  # "user" or "assistant"
    content: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    citations: list["Citation"] = []


class Citation(BaseModel):
    document_id: str = ""
    document_title: str = ""
    cited_text: str = ""
    start_char_index: int = 0
    end_char_index: int = 0
    document_index: int = 0


class Conversation(BaseModel):
    id: Optional[str] = None
    title: str = "New Conversation"
    messages: list[Message] = []
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class ConversationCreate(BaseModel):
    title: str = "New Conversation"


class MessageCreate(BaseModel):
    content: str


class DocumentMeta(BaseModel):
    id: str
    conversation_id: str
    filename: str
    char_count: int
    created_at: datetime


Message.model_rebuild()
