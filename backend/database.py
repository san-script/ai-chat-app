from typing import Annotated, Any

from bson import ObjectId
from motor.motor_asyncio import (
    AsyncIOMotorClient,
    AsyncIOMotorCollection,
    AsyncIOMotorDatabase,
)
from pydantic import GetCoreSchemaHandler
from pydantic_core import core_schema
from pymongo import ASCENDING

from config import settings

# ---------------------------------------------------------------------------
# PyObjectId — ObjectId that round-trips cleanly through Pydantic v2 models
# ---------------------------------------------------------------------------

class PyObjectId(ObjectId):
    """Pydantic v2-compatible ObjectId that serialises to/from a plain string."""

    @classmethod
    def __get_pydantic_core_schema__(
        cls, source_type: Any, handler: GetCoreSchemaHandler
    ) -> core_schema.CoreSchema:
        return core_schema.no_info_plain_validator_function(
            cls._validate,
            serialization=core_schema.to_string_ser_schema(),
        )

    @classmethod
    def _validate(cls, value: Any) -> "PyObjectId":
        if isinstance(value, ObjectId):
            return cls(value)
        if isinstance(value, str) and ObjectId.is_valid(value):
            return cls(value)
        raise ValueError(f"Invalid ObjectId: {value!r}")


PyObjectIdAnnotation = Annotated[PyObjectId, ...]

# ---------------------------------------------------------------------------
# Client / database singleton
# ---------------------------------------------------------------------------

_client: AsyncIOMotorClient | None = None


def get_database() -> AsyncIOMotorDatabase:
    if _client is None:
        raise RuntimeError("Database not connected. Call connect_db() first.")
    return _client[settings.db_name]


def get_collection(name: str) -> AsyncIOMotorCollection:
    return get_database()[name]


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

async def connect_db() -> None:
    global _client
    _client = AsyncIOMotorClient(settings.mongodb_url)
    await _create_indexes()


async def close_db() -> None:
    global _client
    if _client:
        _client.close()
        _client = None


async def _create_indexes() -> None:
    db = get_database()
    await db.messages.create_index(
        [("conversation_id", ASCENDING)], name="messages_conversation_id"
    )
    await db.documents.create_index(
        [("conversation_id", ASCENDING)], name="documents_conversation_id"
    )
