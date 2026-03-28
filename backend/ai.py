import asyncio
from typing import AsyncIterator
import anthropic
from config import settings

_client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

_SYSTEM_DOCS = (
    "Answer questions using ONLY the provided documents. "
    "If the answer is not found in the documents, respond with: "
    "'I couldn't find that information in the provided documents.'"
)


async def stream_response(
    messages: list[dict],
    uploaded_docs: list[dict] | None = None,
) -> AsyncIterator[dict]:
    """Yield text-chunk dicts and (optionally) a citations dict.

    Yields:
        {"type": "text", "content": "<chunk>"}
        {"type": "citations", "citations": [...]}   # only when docs present
    """
    api_messages = _build_messages(messages, uploaded_docs)

    kwargs: dict = {
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 8096,
        "messages": api_messages,
    }
    if uploaded_docs:
        kwargs["system"] = _SYSTEM_DOCS

    async with _client.messages.stream(**kwargs) as stream:
        # Iterate raw events so we can access get_final_message() afterwards
        async for event in stream:
            if (
                getattr(event, "type", None) == "content_block_delta"
                and getattr(getattr(event, "delta", None), "type", None) == "text_delta"
            ):
                yield {"type": "text", "content": event.delta.text}

        if uploaded_docs:
            try:
                result = stream.get_final_message()
                final = (await result) if asyncio.iscoroutine(result) else result
                citations = _extract_citations(final)
                if citations:
                    yield {"type": "citations", "citations": citations}
            except Exception:
                pass  # citations are best-effort; text already streamed


def _build_messages(
    messages: list[dict], uploaded_docs: list[dict] | None
) -> list[dict]:
    if not uploaded_docs:
        return messages

    api_messages = list(messages)
    last_msg = api_messages[-1]
    api_messages[-1] = {
        "role": "user",
        "content": [
            *[
                {
                    "type": "document",
                    "source": {
                        "type": "text",
                        "media_type": "text/plain",
                        "data": doc["text"],
                    },
                    "title": doc["filename"],
                    "citations": {"enabled": True},
                }
                for doc in uploaded_docs
            ],
            {"type": "text", "text": last_msg["content"]},
        ],
    }
    return api_messages


def _extract_citations(final_message) -> list[dict]:
    citations = []
    for block in getattr(final_message, "content", []):
        for cit in getattr(block, "citations", None) or []:
            citations.append(
                {
                    "document_index": getattr(cit, "document_index", 0),
                    "document_title": getattr(cit, "document_title", ""),
                    "cited_text": getattr(cit, "cited_text", ""),
                    "start_char_index": getattr(cit, "start_char_index", 0),
                    "end_char_index": getattr(cit, "end_char_index", 0),
                }
            )
    return citations
