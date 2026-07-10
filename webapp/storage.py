"""Persistent document library backing the MarkItDown web app.

Metadata lives in a single SQLite database; the original uploads and the
converted Markdown live as plain files on disk. Everything is rooted at
``MARKITDOWN_DATA_DIR`` (default: ``<repo>/data``) so it can be mapped to a
Docker volume for durability across container restarts.

Layout::

    <data_dir>/
        library.db          # SQLite metadata
        originals/<id><ext>  # the file exactly as uploaded (byte-for-byte)
        markdown/<id>.md     # the converted Markdown

The store keeps the original bytes untouched, so a document can always be
re-downloaded either as faithful Markdown or as the exact source file.
"""

from __future__ import annotations

import os
import re
import shutil
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional


def _default_data_dir() -> Path:
    env = os.environ.get("MARKITDOWN_DATA_DIR")
    if env:
        return Path(env)
    # webapp/ -> repo root -> data/
    return Path(__file__).resolve().parent.parent / "data"


_SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    title         TEXT,
    extension     TEXT,
    mimetype      TEXT,
    source        TEXT NOT NULL DEFAULT 'upload',  -- 'upload' | 'url'
    source_url    TEXT,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    md_size_bytes INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'ok',       -- 'ok' | 'error'
    error         TEXT,
    has_original  INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);
"""

_COLUMNS = [
    "id",
    "original_name",
    "title",
    "extension",
    "mimetype",
    "source",
    "source_url",
    "size_bytes",
    "md_size_bytes",
    "status",
    "error",
    "has_original",
    "created_at",
]


def _sanitize_stem(name: str) -> str:
    """Make a filesystem/HTTP-safe stem for download filenames."""
    stem = Path(name).stem or "document"
    stem = re.sub(r"[\\/:*?\"<>|\r\n\t]+", "_", stem).strip(" .")
    return stem or "document"


def _clean_ext(ext: Optional[str]) -> str:
    """Reduce an extension to a leading dot + alphanumerics (defense in depth:
    the extension originates from an attacker-influenceable filename)."""
    ext = (ext or "").strip()
    if not ext:
        return ""
    body = re.sub(r"[^A-Za-z0-9]", "", ext.lstrip("."))[:16]
    return ("." + body) if body else ""


class Library:
    """Thread-safe document library backed by SQLite + a data directory."""

    def __init__(self, data_dir: Optional[Path] = None) -> None:
        self.data_dir = Path(data_dir) if data_dir else _default_data_dir()
        self.originals_dir = self.data_dir / "originals"
        self.markdown_dir = self.data_dir / "markdown"
        # Uploads are streamed here first, then moved (same-filesystem rename)
        # into originals/ — this keeps large files off the heap.
        self.tmp_dir = self.data_dir / "tmp"
        self.db_path = self.data_dir / "library.db"
        self._lock = threading.Lock()

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.originals_dir.mkdir(parents=True, exist_ok=True)
        self.markdown_dir.mkdir(parents=True, exist_ok=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)
        self._cleanup_tmp()
        self._init_db()

    def _cleanup_tmp(self) -> None:
        """Remove upload temp files orphaned by a previous crash."""
        for f in self.tmp_dir.glob("*"):
            try:
                if f.is_file():
                    f.unlink()
            except OSError:
                pass

    def new_temp_path(self, suffix: str = "") -> Path:
        """A fresh path in the data-dir temp folder (same FS as originals/)."""
        return self.tmp_dir / (uuid.uuid4().hex + _clean_ext(suffix))

    # -- low-level ---------------------------------------------------------

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        d = {k: row[k] for k in row.keys()}
        d["has_original"] = bool(d.get("has_original"))
        return d

    # -- paths -------------------------------------------------------------

    def markdown_path(self, doc_id: str) -> Path:
        return self.markdown_dir / f"{doc_id}.md"

    def original_path(self, doc_id: str, extension: str) -> Path:
        ext = extension or ""
        if ext and not ext.startswith("."):
            ext = "." + ext
        return self.originals_dir / f"{doc_id}{ext}"

    # -- writes ------------------------------------------------------------

    def add(
        self,
        *,
        original_name: str,
        extension: str = "",
        mimetype: Optional[str] = None,
        source: str = "upload",
        source_url: Optional[str] = None,
        original_src: Optional[Path] = None,
        markdown: Optional[str] = None,
        title: Optional[str] = None,
        status: str = "ok",
        error: Optional[str] = None,
    ) -> dict[str, Any]:
        """Persist a new document and return its metadata record.

        ``original_src`` is a file (typically a streamed temp upload) that is
        *moved* into the originals store — no bytes are held in memory, so the
        original file size is effectively unbounded.
        """
        doc_id = uuid.uuid4().hex
        created_at = datetime.now(timezone.utc).isoformat()
        extension = _clean_ext(extension)

        size_bytes = 0
        has_original = False
        if original_src is not None:
            dest = self.original_path(doc_id, extension)
            shutil.move(str(original_src), str(dest))
            size_bytes = dest.stat().st_size
            has_original = True

        md_size_bytes = 0
        if markdown is not None:
            md_path = self.markdown_path(doc_id)
            # Write raw UTF-8 bytes (no platform newline translation) so the
            # on-disk file, md_size_bytes, /download and /markdown all agree.
            # Encode in slices so a huge document isn't duplicated whole in RAM
            # (str slicing is by code point, so UTF-8 bytes are never split).
            step = 1024 * 1024
            with md_path.open("wb") as fh:
                for k in range(0, len(markdown), step):
                    part = markdown[k : k + step].encode("utf-8")
                    fh.write(part)
                    md_size_bytes += len(part)

        record = {
            "id": doc_id,
            "original_name": original_name,
            "title": title,
            "extension": extension,
            "mimetype": mimetype,
            "source": source,
            "source_url": source_url,
            "size_bytes": size_bytes,
            "md_size_bytes": md_size_bytes,
            "status": status,
            "error": error,
            "has_original": 1 if has_original else 0,
            "created_at": created_at,
        }

        with self._lock, self._connect() as conn:
            placeholders = ", ".join(["?"] * len(_COLUMNS))
            conn.execute(
                f"INSERT INTO documents ({', '.join(_COLUMNS)}) VALUES ({placeholders})",
                [record[c] for c in _COLUMNS],
            )

        record["has_original"] = has_original
        return record

    def delete(self, doc_id: str) -> bool:
        """Delete a document and its files. Returns False if it did not exist."""
        rec = self.get(doc_id)
        if rec is None:
            return False

        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))

        # Remove blobs (best-effort; DB is source of truth).
        md = self.markdown_path(doc_id)
        if md.exists():
            md.unlink()
        if rec.get("has_original"):
            orig = self.original_path(doc_id, rec.get("extension") or "")
            if orig.exists():
                orig.unlink()
        return True

    # -- reads -------------------------------------------------------------

    def list(self, query: Optional[str] = None) -> list[dict[str, Any]]:
        sql = "SELECT * FROM documents"
        params: list[Any] = []
        if query:
            sql += " WHERE original_name LIKE ? OR title LIKE ?"
            like = f"%{query}%"
            params.extend([like, like])
        sql += " ORDER BY created_at DESC"
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def get(self, doc_id: str) -> Optional[dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE id = ?", (doc_id,)
            ).fetchone()
        return self._row_to_dict(row) if row else None

    def get_markdown(self, doc_id: str) -> Optional[str]:
        path = self.markdown_path(doc_id)
        if not path.exists():
            return None
        return path.read_bytes().decode("utf-8")

    def stats(self) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n, "
                "COALESCE(SUM(size_bytes), 0) AS total_bytes, "
                "COALESCE(SUM(md_size_bytes), 0) AS md_bytes "
                "FROM documents"
            ).fetchone()
        return {
            "count": row["n"],
            "total_bytes": row["total_bytes"],
            "markdown_bytes": row["md_bytes"],
        }

    # -- helpers for download filenames -----------------------------------

    @staticmethod
    def markdown_filename(record: dict[str, Any]) -> str:
        return f"{_sanitize_stem(record.get('original_name') or 'document')}.md"

    @staticmethod
    def original_filename(record: dict[str, Any]) -> str:
        name = record.get("original_name") or "document"
        # Keep a real extension if the original name has one.
        return _sanitize_stem(name) + (Path(name).suffix or record.get("extension") or "")
