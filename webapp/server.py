"""FastAPI application exposing MarkItDown as a document-conversion service.

Endpoints
---------
GET  /                              -> the single-page UI
GET  /api/health                    -> version, capabilities, library stats
GET  /api/documents?q=...           -> list library entries (newest first)
POST /api/convert                   -> upload one or more files, convert, store
POST /api/convert-url               -> convert a public URL (http/https)
GET  /api/documents/{id}            -> a single record's metadata
GET  /api/documents/{id}/markdown   -> the converted Markdown (inline, utf-8)
GET  /api/documents/{id}/download   -> the Markdown as an attachment (.md)
GET  /api/documents/{id}/original   -> the original upload, byte-for-byte
DELETE /api/documents/{id}          -> remove a record and its files

Security note: MarkItDown performs I/O with the privileges of this process.
This app is intended for trusted, local/single-tenant use. Do not expose it to
untrusted networks without adding authentication and input restrictions (see
the project README's "Security Considerations").
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from markitdown import (
    MarkItDown,
    StreamInfo,
    MarkItDownException,
)

from . import __version__
from .storage import Library

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("markitdown.web")

STATIC_DIR = Path(__file__).resolve().parent / "static"
UPLOAD_CHUNK = 1024 * 1024  # stream uploads to disk in 1 MB chunks


def _parse_upload_limit() -> tuple[Optional[float], Optional[int]]:
    """Parse MARKITDOWN_MAX_UPLOAD_MB. 0 / empty / 'unlimited' -> no limit.

    Default is unlimited: files are streamed to disk, so size is bounded by
    available disk space, not memory.
    """
    raw = os.environ.get("MARKITDOWN_MAX_UPLOAD_MB", "0").strip().lower()
    if raw in ("", "0", "unlimited", "none", "off", "-1"):
        return None, None
    try:
        mb = float(raw)
    except ValueError:
        return None, None
    if mb <= 0:
        return None, None
    return mb, int(mb * 1024 * 1024)


MAX_UPLOAD_MB, MAX_UPLOAD_BYTES = _parse_upload_limit()

# Formats we advertise in the UI. MarkItDown will attempt anything it detects;
# this is just the human-facing list.
SUPPORTED_FORMATS = [
    "PDF", "DOCX", "PPTX", "XLSX", "XLS", "HTML", "CSV", "JSON", "XML",
    "EPUB", "ZIP", "MSG", "IPYNB", "Kép (OCR/EXIF)", "Hang (átirat)", "URL",
]

library = Library()


def _build_markitdown() -> MarkItDown:
    """Create a MarkItDown instance, wiring an LLM client only if configured.

    Set MARKITDOWN_LLM_MODEL (and OPENAI_API_KEY, plus OPENAI_BASE_URL for
    OpenAI-compatible endpoints) to enable image descriptions / captions.
    """
    kwargs: dict[str, Any] = {"enable_builtins": True}
    model = os.environ.get("MARKITDOWN_LLM_MODEL")
    if model and os.environ.get("OPENAI_API_KEY"):
        try:
            from openai import OpenAI

            client_kwargs: dict[str, Any] = {}
            base_url = os.environ.get("OPENAI_BASE_URL")
            if base_url:
                client_kwargs["base_url"] = base_url
            kwargs["llm_client"] = OpenAI(**client_kwargs)
            kwargs["llm_model"] = model
            logger.info("LLM image descriptions enabled (model=%s)", model)
        except Exception as exc:  # pragma: no cover - optional path
            logger.warning("LLM support requested but unavailable: %s", exc)
    return MarkItDown(**kwargs)


# A single shared converter, guarded by a lock. Conversions run in a threadpool
# (so the event loop stays responsive); the lock serializes access to the shared
# MarkItDown/Magika instance, which is not guaranteed to be thread-safe.
_md = _build_markitdown()
_convert_lock = threading.Lock()

app = FastAPI(title="MarkItDown Web", version=__version__)


# --------------------------------------------------------------------------
# Conversion helpers (run in a threadpool — they are blocking / CPU-bound)
# --------------------------------------------------------------------------

def _process_upload(temp_path: Path, filename: str, keep_original: bool) -> dict[str, Any]:
    """Convert one already-streamed upload (on disk) and persist it.

    The original is moved into the library (never copied through memory) when
    keep_original is set; otherwise the temp file is removed. Reading happens
    from disk via convert_local, so file size is bounded by disk, not RAM.
    """
    extension = Path(filename).suffix
    src = temp_path if keep_original else None
    try:
        stream_info = StreamInfo(filename=filename, extension=extension or None)
        with _convert_lock:
            result = _md.convert_local(str(temp_path), stream_info=stream_info)
        return library.add(
            original_name=filename,
            extension=extension,
            source="upload",
            original_src=src,
            markdown=result.markdown,
            title=result.title or Path(filename).stem,
            status="ok",
        )
    except MarkItDownException as exc:
        logger.warning("Conversion failed for %s: %s", filename, exc)
        return library.add(
            original_name=filename,
            extension=extension,
            source="upload",
            original_src=src,
            markdown=None,
            status="error",
            error=str(exc),
        )
    except Exception as exc:  # noqa: BLE001 - surface any failure to the user
        logger.exception("Unexpected error converting %s", filename)
        return library.add(
            original_name=filename,
            extension=extension,
            source="upload",
            original_src=src,
            markdown=None,
            status="error",
            error=f"{type(exc).__name__}: {exc}",
        )
    finally:
        # If it wasn't moved into the library (not kept, or failed early), drop it.
        temp_path.unlink(missing_ok=True)


def _rejected_upload(filename: str) -> dict[str, Any]:
    """Persist a visible 'too large' error entry (no bytes stored)."""
    limit = f"{MAX_UPLOAD_MB:.0f}" if MAX_UPLOAD_MB is not None else "?"
    return library.add(
        original_name=filename,
        extension=Path(filename).suffix,
        source="upload",
        original_src=None,
        markdown=None,
        status="error",
        error=f"A fájl meghaladja a {limit} MB méretkorlátot.",
    )


def _process_url(url: str) -> dict[str, Any]:
    try:
        with _convert_lock:
            result = _md.convert_uri(url)
        title = result.title or urlparse(url).netloc or url
        return library.add(
            original_name=title,
            extension=".md",
            source="url",
            source_url=url,
            original_src=None,
            markdown=result.markdown,
            title=title,
            status="ok",
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected error converting URL %s", url)
        return library.add(
            original_name=url,
            extension=".md",
            source="url",
            source_url=url,
            original_src=None,
            markdown=None,
            status="error",
            error=f"{type(exc).__name__}: {exc}",
        )


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "version": __version__,
        "formats": SUPPORTED_FORMATS,
        "max_upload_mb": MAX_UPLOAD_MB,
        "llm_enabled": _md._llm_client is not None,  # type: ignore[attr-defined]
        "library": library.stats(),
    }


@app.get("/api/documents")
def list_documents(q: Optional[str] = None) -> dict[str, Any]:
    return {"documents": library.list(q)}


@app.post("/api/convert")
async def convert(
    files: list[UploadFile] = File(...),
    keep_original: bool = Form(True),
) -> JSONResponse:
    if not files:
        raise HTTPException(status_code=400, detail="Nincs feltöltött fájl.")

    documents: list[dict[str, Any]] = []
    for upload in files:
        filename = upload.filename or "feltoltott_fajl"
        temp_path = library.new_temp_path(Path(filename).suffix)

        # Stream the upload to disk in chunks (never hold the whole file in RAM).
        # With MAX_UPLOAD_BYTES unset (default), size is bounded only by disk.
        size = 0
        too_big = False
        try:
            with temp_path.open("wb") as fh:
                while True:
                    chunk = await upload.read(UPLOAD_CHUNK)
                    if not chunk:
                        break
                    size += len(chunk)
                    if MAX_UPLOAD_BYTES is not None and size > MAX_UPLOAD_BYTES:
                        too_big = True
                        break
                    fh.write(chunk)
        finally:
            await upload.close()

        if too_big:
            temp_path.unlink(missing_ok=True)
            documents.append(await run_in_threadpool(_rejected_upload, filename))
            continue

        record = await run_in_threadpool(
            _process_upload, temp_path, filename, keep_original
        )
        documents.append(record)

    return JSONResponse({"documents": documents})


class UrlPayload(BaseModel):
    url: str


@app.post("/api/convert-url")
async def convert_url(payload: UrlPayload) -> JSONResponse:
    url = payload.url.strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(
            status_code=400,
            detail="Csak http(s) URL-ek engedélyezettek.",
        )
    record = await run_in_threadpool(_process_url, url)
    return JSONResponse({"documents": [record]})


@app.get("/api/documents/{doc_id}")
def get_document(doc_id: str) -> dict[str, Any]:
    record = library.get(doc_id)
    if record is None:
        raise HTTPException(status_code=404, detail="A dokumentum nem található.")
    return record


@app.get("/api/documents/{doc_id}/markdown", response_class=PlainTextResponse)
def get_markdown(doc_id: str) -> PlainTextResponse:
    record = library.get(doc_id)
    if record is None:
        raise HTTPException(status_code=404, detail="A dokumentum nem található.")
    md = library.get_markdown(doc_id)
    if md is None:
        raise HTTPException(
            status_code=404,
            detail="Ehhez a dokumentumhoz nincs Markdown (a konvertálás hibás volt).",
        )
    return PlainTextResponse(md, media_type="text/markdown; charset=utf-8")


@app.get("/api/documents/{doc_id}/download")
def download_markdown(doc_id: str) -> FileResponse:
    record = library.get(doc_id)
    if record is None:
        raise HTTPException(status_code=404, detail="A dokumentum nem található.")
    path = library.markdown_path(doc_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Nincs letölthető Markdown.")
    return FileResponse(
        path,
        media_type="text/markdown; charset=utf-8",
        filename=library.markdown_filename(record),
    )


@app.get("/api/documents/{doc_id}/original")
def download_original(doc_id: str) -> FileResponse:
    record = library.get(doc_id)
    if record is None:
        raise HTTPException(status_code=404, detail="A dokumentum nem található.")
    if not record.get("has_original"):
        raise HTTPException(
            status_code=404,
            detail="Az eredeti fájl nem lett elmentve ehhez a dokumentumhoz.",
        )
    path = library.original_path(doc_id, record.get("extension") or "")
    if not path.exists():
        raise HTTPException(status_code=404, detail="Az eredeti fájl nem található.")
    return FileResponse(
        path,
        media_type=record.get("mimetype") or "application/octet-stream",
        filename=library.original_filename(record),
    )


@app.delete("/api/documents/{doc_id}")
def delete_document(doc_id: str) -> dict[str, Any]:
    if not library.delete(doc_id):
        raise HTTPException(status_code=404, detail="A dokumentum nem található.")
    return {"deleted": doc_id}


# --------------------------------------------------------------------------
# Static UI (mounted last so it does not shadow /api routes)
# --------------------------------------------------------------------------

@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
