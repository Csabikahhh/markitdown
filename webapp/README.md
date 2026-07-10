# MarkItDown Web

A small web application on top of [MarkItDown](../packages/markitdown): upload
documents (PDF, Word, Excel, PowerPoint, HTML, images, audio, …), convert them
to Markdown, and keep everything in a browsable **document library** you can
download from at any time.

![](https://img.shields.io/badge/stack-FastAPI%20%2B%20vanilla%20JS-9a3722)

## Features

- **Drag-and-drop upload** of one or many files, plus **URL conversion**
  (web pages, YouTube, Wikipedia).
- **PDF and everything else MarkItDown supports** — conversion runs fully
  offline (no cloud key required).
- **Document library (dokumentumtár):** every conversion is stored and
  persisted (SQLite metadata + files on disk), searchable, with a rich viewer
  (rendered preview **and** raw Markdown source).
- **Lossless downloads:** grab the faithful `.md`, or the **original file
  byte-for-byte** (when "keep original" is on).
- **Runs in Docker** with a persistent volume — one command to start.

## Quick start (Docker)

```bash
docker compose up --build
# open http://localhost:8000
```

The library lives in the `markitdown-data` volume, so it survives restarts.

## Quick start (local, no Docker)

```bash
# from the repo root
pip install ./packages/markitdown[all]
pip install -r webapp/requirements.txt
uvicorn webapp.server:app --reload --port 8000
# open http://localhost:8000
```

By default the library is written to `./data/` (override with
`MARKITDOWN_DATA_DIR`).

## Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `MARKITDOWN_DATA_DIR` | `<repo>/data` (`/data` in Docker) | Where the library is stored |
| `MARKITDOWN_MAX_UPLOAD_MB` | `0` (unlimited) | Per-file upload size limit; `0` = unlimited (streamed to disk) |
| `MARKITDOWN_LLM_MODEL` | — | Enable image descriptions (e.g. `gpt-4o`) |
| `OPENAI_API_KEY` | — | Required if `MARKITDOWN_LLM_MODEL` is set |
| `OPENAI_BASE_URL` | — | For OpenAI-compatible endpoints |

Copy `.env.example` to `.env` to set these for `docker compose`.

## HTTP API

| Method & path | Description |
|---------------|-------------|
| `GET /api/health` | Version, supported formats, library stats |
| `GET /api/documents?q=` | List library entries (newest first) |
| `POST /api/convert` | Multipart upload (`files`, `keep_original`) |
| `POST /api/convert-url` | JSON `{ "url": "https://…" }` |
| `GET /api/documents/{id}` | One record's metadata |
| `GET /api/documents/{id}/markdown` | Converted Markdown (inline) |
| `GET /api/documents/{id}/download` | Markdown as an attachment (`.md`) |
| `GET /api/documents/{id}/original` | Original upload, byte-for-byte |
| `DELETE /api/documents/{id}` | Delete a record and its files |

## Security

MarkItDown performs I/O with the privileges of the process. This app is meant
for **trusted, local, single-user** use. It ships bound to `127.0.0.1` and has
no authentication. Before exposing it to a network, add authentication and
restrict inputs — see the project root `README.md` → *Security Considerations*.
URL conversion in particular should not be pointed at untrusted input in a
shared environment (SSRF risk).

## Data layout

```
<MARKITDOWN_DATA_DIR>/
  library.db            # SQLite metadata
  originals/<id><ext>   # exact bytes of each upload
  markdown/<id>.md      # converted Markdown
```
