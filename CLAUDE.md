# AI Chat App — CLAUDE.md

## Project Overview

Full-stack AI chat application. Users create conversations and exchange messages with Claude; responses stream token-by-token via Server-Sent Events (SSE).

**Stack:** FastAPI + Motor (async MongoDB) · React 18 + TypeScript · MongoDB · Anthropic API

---

## Key Commands

| Task           | Command                                        |
|----------------|------------------------------------------------|
| Start all      | `docker compose up --build`                    |
| Backend only   | `docker compose up backend`                    |
| Rebuild one    | `docker compose up --build backend`            |
| View logs      | `docker compose logs -f backend`               |
| Run tests      | `docker compose exec backend pytest`           |
| Mongo shell    | `docker compose exec mongo mongosh`            |
| Stop all       | `docker compose down`                          |
| Wipe DB        | `docker compose down -v`                       |

---

## Project Structure

```
ai-chat-app/
├── backend/
│   ├── __init__.py
│   ├── main.py          # FastAPI app, all route handlers
│   ├── models.py        # Pydantic models (Message, Conversation, request bodies)
│   ├── database.py      # Motor client lifecycle (connect_db / close_db / get_database)
│   ├── config.py        # pydantic-settings Settings class, reads from .env
│   ├── ai.py            # stream_response() — Anthropic streaming wrapper
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── lib/api.ts   # All fetch calls + SSE async generator (sendMessage)
│   │   └── hooks/useChat.ts  # React hook managing messages/streaming/error state
│   ├── nginx.conf        # Reverse-proxy /conversations → backend:8000; SSE config
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── Dockerfile        # Multi-stage: node builder → nginx:alpine
├── .env                  # Local secrets (never commit)
├── .gitignore
└── CLAUDE.md
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in values. Never commit `.env`.

| Variable           | Required | Default                    | Description                        |
|--------------------|----------|----------------------------|------------------------------------|
| `ANTHROPIC_API_KEY`| yes      | —                          | Anthropic API key (`sk-ant-…`)     |
| `MONGODB_URL`      | no       | `mongodb://mongo:27017`    | Motor connection string            |
| `DB_NAME`          | no       | `chatapp`                  | MongoDB database name              |
| `GITHUB_TOKEN`     | no       | —                          | Only needed for GitHub automation  |

`config.py` loads these via `pydantic-settings`; the backend will refuse to start if `ANTHROPIC_API_KEY` is missing.

---

## Docker Services

| Service    | Image / Build     | Internal port | Exposed port | Notes                               |
|------------|-------------------|---------------|--------------|-------------------------------------|
| `mongo`    | `mongo:7`         | 27017         | 27017        | Data volume: `mongo_data`           |
| `backend`  | `./backend`       | 8000          | 8000         | Uvicorn with `--reload`             |
| `frontend` | `./frontend`      | 80            | 5173         | nginx serves build + proxies API    |

nginx proxies all `/conversations` traffic to `backend:8000` with `proxy_buffering off` for SSE.

### Docker Compose Commands

```bash
# Start all services (detached)
docker compose up -d

# Start and rebuild images (after code/dependency changes)
docker compose up -d --build

# Rebuild a single service
docker compose up -d --build backend

# Stop all services
docker compose down

# Stop and remove volumes (wipes MongoDB data)
docker compose down -v

# View logs (all services)
docker compose logs -f

# View logs for one service
docker compose logs -f backend

# Open a shell in the backend container
docker compose exec backend bash

# Open a MongoDB shell
docker compose exec mongo mongosh chatapp

# Run a one-off backend command (e.g. check imports)
docker compose run --rm backend python -c "from main import app; print('OK')"
```

---

## Coding Standards

### Backend (Python)

- **Python 3.12**. Use `from __future__ import annotations` only when needed.
- Type-annotate all function signatures.
- Use `async`/`await` throughout — never call blocking I/O in a coroutine.
- Route handlers live in `main.py`. Business logic goes in dedicated modules (`ai.py`, etc.).
- Settings are accessed only through `config.settings` — never read `os.environ` directly.
- Raise `HTTPException` for all error responses; never return raw dicts with error fields.

### MongoDB Conventions

- **Use Motor (async) exclusively** — never import or call `pymongo` sync methods inside a coroutine. All Motor calls must be `await`ed.
- **Document IDs:** stored as `ObjectId` in MongoDB; always exposed to the API as a plain `str` via the `_id` → `id` alias. Use the `_serialize` helper in `main.py` for this conversion. Never expose a raw `ObjectId` to API consumers.
- **Never pass raw `dict` objects to Motor insert/update calls.** Always use Pydantic models and call `.model_dump()`. Nested models (e.g. `Message` inside `Conversation`) serialize the same way.
- **Query by `_id`** with `ObjectId(conversation_id)` — catch `bson.errors.InvalidId` on malformed IDs and raise `HTTPException(400)`.
- **Collection naming:** `snake_case` plural — e.g. `conversations`, `messages`.
- **Required fields on every document:** `_id` (ObjectId), `created_at` (datetime, UTC), `updated_at` (datetime, UTC). Always set both on insert; update `updated_at` on every write.
- **Soft deletes:** never hard-delete user data. Set a `deleted_at` (datetime, UTC) field instead. All list/get queries must filter `{"deleted_at": None}` (or `{"deleted_at": {"$exists": False}}`).
- **Indexes:** always create an index on `conversation_id` for any collection that references conversations (e.g. a future `messages` collection). Define indexes at app startup in `database.py` using `create_index` / `create_indexes`.
- **Never return raw dicts from route handlers.** Every endpoint must declare a `response_model` and return a Pydantic model instance (or a list thereof). The `_serialize` helper is a temporary bridge for existing code — new routes must use proper response models.

### Pydantic Models (`models.py`)

```python
# Request bodies  → *Create suffix  (ConversationCreate, MessageCreate)
# DB/response     → plain name      (Conversation, Message)
```

- `Message`: `role` (`"user"` | `"assistant"`), `content`, `created_at`
- `Conversation`: `id`, `title`, `messages: list[Message]`, `created_at`, `updated_at`

### AI / Anthropic (`ai.py`)

- Model: **`claude-sonnet-4-20250514`**
- `stream_response(messages)` is an `AsyncGenerator[str, None]` — consume with `async for chunk in stream_response(...)`.
- Always pass the full message history so Claude has conversation context.
- `max_tokens` is set at the call site; do not hard-code it in the generator.

### Frontend (TypeScript/React)

- Strict TypeScript (`"strict": true` in `tsconfig.json`). No `any`.
- All API calls live in `src/lib/api.ts`. Components and hooks import from there — never `fetch` directly in a component.
- Streaming is handled by the `sendMessage` async generator; UI updates via `useChat` hook.
- `useChat` owns all message/streaming/error state. Components call `send()` and read state — they do not manage SSE directly.
- Use `useCallback` for stable function references in hooks.

---

## API Endpoints

| Method   | Path                                        | Description                                  |
|----------|---------------------------------------------|----------------------------------------------|
| `GET`    | `/conversations`                            | List all conversations (no messages)         |
| `POST`   | `/conversations`                            | Create conversation (`ConversationCreate`)   |
| `GET`    | `/conversations/{id}`                       | Get conversation with full message history   |
| `DELETE` | `/conversations/{id}`                       | Delete conversation                          |
| `POST`   | `/conversations/{id}/messages`              | Send message; returns SSE stream             |

SSE stream format:
```
data: {"text": "<token>"}\n\n
...
data: [DONE]\n\n
```

---

## Git Workflow

- `main` — production-ready, protected. Never push directly.
- `dev` — integration branch. PRs merge here first.
- Feature branches: `feature/<short-description>`
- Bug fix branches: `fix/<short-description>`

```bash
git checkout -b feature/my-feature
# ... make changes ...
git push origin feature/my-feature
# open PR → dev
```

Commit messages follow Conventional Commits:
```
feat: add conversation search endpoint
fix: handle ObjectId cast error on bad conversation ID
chore: upgrade anthropic sdk to 0.30.0
```

---

## PR Checklist

Before opening a pull request, verify:

**Backend**
- [ ] All new route handlers are async and use `await` for every I/O call
- [ ] MongoDB writes use Pydantic `.model_dump()` — no raw `dict` literals inserted
- [ ] `ObjectId` values are converted to `str` before returning from any endpoint
- [ ] `HTTPException` used for all error paths (not bare `return {"error": ...}`)
- [ ] New env vars added to `config.py` (Settings) and documented in this file
- [ ] `requirements.txt` updated if a new package was added

**Frontend**
- [ ] No `any` types introduced — run `tsc --noEmit` locally
- [ ] New fetch calls go in `src/lib/api.ts`, not inline in components
- [ ] SSE / streaming logic stays inside `useChat` or `api.ts`
- [ ] No secrets or `.env` values referenced in frontend code

**General**
- [ ] `.env` is not committed (check `.gitignore`)
- [ ] `docker compose up -d --build` succeeds cleanly
- [ ] No `console.log` / `print` debug statements left in
- [ ] PR description explains *what* changed and *why*
