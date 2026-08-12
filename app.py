#!/usr/bin/env python3
"""B2 网页版上传/下载小工具。

- 配置：.env（参考 .env.example），Python 依赖由 uv 管理
- 鉴权：所有请求需带 ?apikey=<APP_API_KEY>
- 上传：文件先落盘到 tmp_uploads/，后台单线程队列上传，任务记录在 jobs.db
- 下载：从 B2 流式返回给浏览器
"""

from __future__ import annotations

import argparse
import hashlib
import os
import queue
import secrets
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from dotenv import load_dotenv
from flask import (
    Flask,
    Response,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    url_for,
)
from flask_socketio import SocketIO, emit

from backblaze_upload import clean_prefix, normalize_endpoint

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "jobs.db"
UPLOAD_DIR = BASE_DIR / "tmp_uploads"
MAX_JOBS_SHOWN = 50
DEFAULT_REGION = "us-east-1"
JOB_QUEUE: queue.Queue[int] = queue.Queue()

load_dotenv(BASE_DIR / ".env")

TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=100 * 1024 * 1024,
    multipart_chunksize=100 * 1024 * 1024,
    max_concurrency=4,
    use_threads=True,
)

app = Flask(__name__)
app.secret_key = secrets.token_hex(16)
socketio = SocketIO(app, async_mode="threading")

_CLIENT = None
BUCKET_PRIVATE: bool | None = None
BUCKET_PRIVATE_NOTE = ""


def format_bytes(value: float) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.2f} {unit}"
        value /= 1024
    return f"{value:.2f} TiB"


def format_time(epoch: float) -> str:
    return "--" if not epoch else time.strftime("%Y-%m-%d %H:%M", time.localtime(epoch))


# --------------------------------------------------------------------------
# 配置与 boto3 client
# --------------------------------------------------------------------------

def validate_config() -> str | None:
    required = ("B2_APPLICATION_KEY_ID", "B2_APPLICATION_KEY", "B2_BUCKET", "APP_API_KEY")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        return (
            "缺少配置项: " + ", ".join(missing)
            + "（请复制 .env.example 为 .env 并填写）"
        )
    if not os.environ.get("B2_ENDPOINT") and not os.environ.get("B2_REGION"):
        return "Endpoint/Region 配置无效: B2_ENDPOINT 与 B2_REGION 至少配置一个"
    try:
        resolve_endpoint()
    except ValueError as exc:
        return f"Endpoint/Region 配置无效: {exc}"
    return None


def resolve_endpoint() -> tuple[str, str]:
    """解析 B2_ENDPOINT / B2_REGION。

    与现有脚本一致：优先使用 B2_ENDPOINT，能推断 region 就用推断值；
    自定义 endpoint 无法推断 region 时不再报错，回退到 DEFAULT_REGION，
    也可用 B2_REGION 显式指定。
    """
    endpoint = os.environ.get("B2_ENDPOINT")
    region = os.environ.get("B2_REGION")
    try:
        return normalize_endpoint(endpoint, region)
    except ValueError:
        if not endpoint:
            raise
        endpoint = endpoint.strip()
        if not endpoint.startswith(("https://", "http://")):
            endpoint = "https://" + endpoint
        return endpoint.rstrip("/"), region or DEFAULT_REGION


def get_client():
    global _CLIENT
    if _CLIENT is None:
        endpoint, region = resolve_endpoint()
        _CLIENT = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=os.environ["B2_APPLICATION_KEY_ID"],
            aws_secret_access_key=os.environ["B2_APPLICATION_KEY"],
            config=Config(signature_version="s3v4", retries={"max_attempts": 8, "mode": "standard"}),
        )
    return _CLIENT


def server_root() -> Path | None:
    """SERVER_FILE_ROOT 配置的服务器文件根目录；未配置返回 None。"""
    raw = os.environ.get("SERVER_FILE_ROOT", "").strip()
    if not raw:
        return None
    root = Path(raw).expanduser()
    if not root.is_absolute():
        root = BASE_DIR / root
    return root.resolve()


def resolve_server_path(raw: str) -> Path:
    """解析服务器路径并校验在 SERVER_FILE_ROOT 内（未配置时不限制）。"""
    if not raw or not raw.strip():
        raise ValueError("请输入绝对路径")
    root = server_root()
    path = Path(raw).expanduser().resolve()
    if not path.is_absolute():
        raise ValueError("请输入绝对路径")
    if root is not None:
        try:
            path.relative_to(root)
        except ValueError:
            raise ValueError(f"路径必须在 SERVER_FILE_ROOT 目录内: {root}") from None
    return path


def list_server_files() -> tuple[str | None, list[dict]]:
    root = server_root()
    if root is None:
        return None, []
    root.mkdir(parents=True, exist_ok=True)
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.is_symlink():
            try:
                relative = path.relative_to(root).as_posix()
            except ValueError:
                continue
            files.append({"path": relative, "size": path.stat().st_size, "absolute": str(path)})
    return str(root), files


# --------------------------------------------------------------------------
# SQLite 任务记录
# --------------------------------------------------------------------------

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT NOT NULL DEFAULT 'upload',
                filename TEXT NOT NULL,
                object_key TEXT NOT NULL,
                source TEXT,
                destination TEXT,
                size INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'queued',
                progress INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at REAL NOT NULL,
                started_at REAL,
                finished_at REAL
            )
            """
        )
        # 兼容旧库：补齐新增列
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
        for name, definition in (
            ("kind", "TEXT NOT NULL DEFAULT 'upload'"),
            ("source", "TEXT"),
            ("destination", "TEXT"),
            ("note", "TEXT"),
        ):
            if name not in columns:
                conn.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                object_key TEXT NOT NULL,
                md5 TEXT NOT NULL,
                size INTEGER NOT NULL DEFAULT 0,
                source_url TEXT,
                status TEXT NOT NULL DEFAULT 'synced',
                created_at REAL NOT NULL,
                synced_at REAL,
                error TEXT
            )
            """
        )
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_files_md5 ON files(md5)")


def recent_jobs(limit: int = MAX_JOBS_SHOWN) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(row) for row in rows]


def insert_job(
    *,
    kind: str,
    filename: str,
    object_key: str,
    size: int,
    source: str | None = None,
    destination: str | None = None,
) -> int:
    with get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO jobs (kind, filename, object_key, source, destination, size, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)",
            (kind, filename, object_key, source, destination, size, time.time()),
        )
        return cursor.lastrowid


def job_payload(job: dict) -> dict:
    return {
        "id": job["id"],
        "kind": job["kind"],
        "filename": job["filename"],
        "object_key": job["object_key"],
        "source": job.get("source"),
        "destination": job.get("destination"),
        "note": job.get("note"),
        "size": job["size"],
        "status": job["status"],
        "progress": job["progress"],
        "error": job["error"],
        "created_at": job["created_at"],
    }


def emit_job_update(job_id: int) -> None:
    """向所有已连接的页面广播单个任务的最新状态。"""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is not None:
        socketio.emit("job_update", job_payload(dict(row)))


# --------------------------------------------------------------------------
# 后台上传队列
# --------------------------------------------------------------------------

def make_progress(job_id: int, size: int):
    lock = threading.Lock()
    state = {"progress": 0, "last": 0.0}

    def callback(amount: int) -> None:
        with lock:
            if size > 0:
                state["progress"] = min(size, state["progress"] + amount)
            else:
                state["progress"] += amount
            now = time.monotonic()
            if now - state["last"] >= 0.5 or (size > 0 and state["progress"] >= size):
                state["last"] = now
                with get_db() as conn:
                    conn.execute(
                        "UPDATE jobs SET progress=? WHERE id=?",
                        (state["progress"], job_id),
                    )
                emit_job_update(job_id)

    return callback


def upload_to_bucket(source: Path, object_key: str, job_id: int, size: int) -> None:
    get_client().upload_file(
        str(source),
        os.environ["B2_BUCKET"],
        object_key,
        Callback=make_progress(job_id, size),
        Config=TRANSFER_CONFIG,
    )


def download_to_path(object_key: str, size: int, destination: Path, job_id: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".part", dir=str(destination.parent)
    )
    os.close(fd)
    completed = False
    try:
        get_client().download_file(
            os.environ["B2_BUCKET"],
            object_key,
            temporary_name,
            Callback=make_progress(job_id, size),
            Config=TRANSFER_CONFIG,
        )
        actual_size = os.path.getsize(temporary_name)
        if actual_size != size:
            raise OSError(f"文件大小校验失败：预期 {size}，实际 {actual_size}")
        os.replace(temporary_name, destination)
        completed = True
    finally:
        if not completed:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def fetch_url_to_temp(url: str, job_id: int) -> tuple[Path, int, str]:
    """从 URL 流式下载到临时文件，返回（临时路径, 文件大小, md5）。"""
    request = Request(url, headers={"User-Agent": "b2-file-manager/0.1"})
    temp_path = UPLOAD_DIR / f"{job_id}.part"
    digest = hashlib.md5()
    with urlopen(request, timeout=60) as response:
        total = int(response.headers.get("Content-Length") or 0)
        if total > 0:
            with get_db() as conn:
                conn.execute("UPDATE jobs SET size=? WHERE id=?", (total, job_id))
            emit_job_update(job_id)
        callback = make_progress(job_id, total)
        with open(temp_path, "wb") as out:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                digest.update(chunk)
                callback(len(chunk))
    size = temp_path.stat().st_size
    with get_db() as conn:
        conn.execute("UPDATE jobs SET size=? WHERE id=?", (size, job_id))
    emit_job_update(job_id)
    return temp_path, size, digest.hexdigest()


def hash_file(path: Path) -> str:
    """计算本地文件 md5。"""
    digest = hashlib.md5()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def ensure_unique_md5(md5: str, job_id: int) -> bool:
    """md5 已存在时跳过上传并给任务加备注，返回是否为新文件。"""
    with get_db() as conn:
        row = conn.execute("SELECT object_key FROM files WHERE md5=?", (md5,)).fetchone()
    if row is not None:
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET note=? WHERE id=?",
                (f"md5 已存在，跳过上传（已存于 {row['object_key']}）", job_id),
            )
        emit_job_update(job_id)
        return False
    return True


def verify_object(object_key: str, size: int) -> None:
    meta = get_client().head_object(Bucket=os.environ["B2_BUCKET"], Key=object_key)
    actual = int(meta["ContentLength"])
    if actual != size:
        raise OSError(f"上传校验失败：bucket 中 {actual} 字节，本地 {size} 字节")


def insert_file_record(object_key: str, md5: str, size: int, source_url: str | None = None) -> None:
    with get_db() as conn:
        conn.execute(
            "INSERT INTO files (object_key, md5, size, source_url, status, created_at, synced_at) "
            "VALUES (?, ?, ?, ?, 'synced', ?, ?)",
            (object_key, md5, size, source_url, time.time(), time.time()),
        )


def sync_to_bucket(
    source_path: Path, object_key: str, job_id: int, size: int, md5: str, source_url: str | None = None
) -> bool:
    """上传到 bucket 并登记 files 记录；md5 重复时跳过，返回是否真正上传。"""
    if not ensure_unique_md5(md5, job_id):
        return False
    upload_to_bucket(source_path, object_key, job_id, size)
    verify_object(object_key, size)
    insert_file_record(object_key, md5, size, source_url)
    return True


def cleanup_job_temp(job_id: int, kind: str, destination: str | None = None) -> None:
    """清理任务产生的临时文件（服务器路径上传任务的源文件不属于临时文件）。"""
    if kind == "download" and destination:
        try:
            dest = Path(destination)
            for leftover in dest.parent.glob(f".{dest.name}.*.part"):
                leftover.unlink(missing_ok=True)
        except OSError:
            pass
    else:
        try:
            (UPLOAD_DIR / f"{job_id}.part").unlink(missing_ok=True)
        except OSError:
            pass


def process_job(job_id: int) -> None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None or row["status"] != "queued":
            return
        conn.execute(
            "UPDATE jobs SET status='uploading', started_at=? WHERE id=?",
            (time.time(), job_id),
        )
        kind = row["kind"]
        object_key = row["object_key"]
        size = row["size"]
        source = row["source"]
        destination = row["destination"]
    emit_job_update(job_id)

    try:
        if kind == "download":
            download_to_path(object_key, size, Path(destination), job_id)
            final_size = size
        else:
            source_path = (
                Path(source)
                if source and not source.startswith(("http://", "https://"))
                else None
            )
            if kind == "fetch":
                source_path, size, md5 = fetch_url_to_temp(source, job_id)
                if destination:
                    dest = Path(destination)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(source_path), dest)
                else:
                    sync_to_bucket(source_path, object_key, job_id, size, md5, source)
            else:
                if source_path is None:
                    source_path = UPLOAD_DIR / f"{job_id}.part"
                md5 = hash_file(source_path)
                sync_to_bucket(source_path, object_key, job_id, size, md5)
            final_size = size
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET status='done', progress=?, finished_at=? WHERE id=?",
                (final_size, time.time(), job_id),
            )
        emit_job_update(job_id)
    except (BotoCoreError, ClientError, OSError, ValueError, TimeoutError, TypeError) as exc:
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?",
                (str(exc), time.time(), job_id),
            )
        emit_job_update(job_id)
    finally:
        cleanup_job_temp(job_id, kind, destination)


def worker_loop() -> None:
    while True:
        job_id = JOB_QUEUE.get()
        try:
            process_job(job_id)
        except Exception as exc:  # 兜底：未预期异常也标记失败，避免任务卡死
            with get_db() as conn:
                conn.execute(
                    "UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?",
                    (f"内部错误（{exc}），请重试", time.time(), job_id),
                )


def recover_jobs() -> None:
    """重启恢复：上传/下载中的任务标记失败并清理临时文件；排队中的任务继续处理。"""
    with get_db() as conn:
        interrupted = conn.execute("SELECT * FROM jobs WHERE status='uploading'").fetchall()
        for row in interrupted:
            cleanup_job_temp(row["id"], row["kind"], row["destination"])
            conn.execute(
                "UPDATE jobs SET status='failed', error='服务重启，任务中断，请重新提交', "
                "finished_at=? WHERE id=?",
                (time.time(), row["id"]),
            )
        pending = conn.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY id").fetchall()
    for row in pending:
        JOB_QUEUE.put(row["id"])


def cleanup_stale_multipart(max_age_hours: float = 24.0) -> None:
    """清理 B2 中超过阈值仍未完成的分片上传（进程崩溃时的残留兜底）。"""
    try:
        client = get_client()
        cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
        count = 0
        paginator = client.get_paginator("list_multipart_uploads")
        for page in paginator.paginate(Bucket=os.environ["B2_BUCKET"]):
            for upload in page.get("Uploads", []):
                initiated = upload.get("Initiated")
                if initiated is None:
                    continue
                if initiated.tzinfo is None:
                    initiated = initiated.replace(tzinfo=timezone.utc)
                if initiated < cutoff:
                    client.abort_multipart_upload(
                        Bucket=os.environ["B2_BUCKET"],
                        Key=upload["Key"],
                        UploadId=upload["UploadId"],
                    )
                    count += 1
        if count:
            print(f"已清理 {count} 个超过 {max_age_hours:.0f} 小时未完成的分片上传。")
    except (BotoCoreError, ClientError) as exc:
        print(f"清理未完成分片上传失败（可忽略）: {exc}")


def recent_files(limit: int = 50) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM files ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(row) for row in rows]


def check_bucket_private() -> tuple[bool | None, str]:
    """检测 bucket 是否私有：S3 ACL 中出现 AllUsers 公开读即视为公开。"""
    try:
        acl = get_client().get_bucket_acl(Bucket=os.environ["B2_BUCKET"])
        for grant in acl.get("Grants", []):
            grantee = grant.get("Grantee", {})
            uri = grantee.get("URI", "") or ""
            if "AllUsers" in uri:
                return False, "bucket 检测为公开读（ACL 含 AllUsers），请关闭公开访问！"
        return True, "bucket 为私有，禁止外部链接访问 ✓"
    except (BotoCoreError, ClientError) as exc:
        return None, f"无法检测 bucket 公开状态（{exc}）"


# --------------------------------------------------------------------------
# Flask 路由
# --------------------------------------------------------------------------

def apikey_ok() -> bool:
    provided = request.args.get("apikey", "")
    expected = os.environ.get("APP_API_KEY", "")
    return bool(expected) and bool(provided) and secrets.compare_digest(provided, expected)


def require_auth():
    if not apikey_ok():
        return Response("401 未授权", status=401)
    return None


@socketio.on("connect")
def socket_connect():
    if not apikey_ok():
        return False
    emit("jobs_snapshot", [job_payload(job) for job in recent_jobs()])


def list_objects(prefix: str, limit: int = 50) -> list[dict]:
    prefix = prefix.strip("/")
    if prefix:
        prefix += "/"
    objects: list[dict] = []
    client = get_client()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=os.environ["B2_BUCKET"], Prefix=prefix):
        for item in page.get("Contents", []):
            key = item["Key"]
            if key.endswith("/") and int(item.get("Size", 0)) == 0:
                continue
            last_modified = item.get("LastModified")
            objects.append({
                "key": key,
                "size": int(item.get("Size", 0)),
                "last_modified": int(last_modified.timestamp()) if last_modified else 0,
            })
    objects.sort(key=lambda obj: obj["last_modified"], reverse=True)
    return objects[:limit]


def stream_body(body, chunk_size: int = 1024 * 1024):
    try:
        while True:
            chunk = body.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        body.close()


_downloads_lock = threading.Lock()
_active_downloads: dict[str, dict] = {}


def download_payload(
    dl_id: str, key: str, size: int, transferred: int, status: str, error: str | None = None
) -> dict:
    return {
        "id": dl_id,
        "key": key,
        "size": size,
        "transferred": transferred,
        "status": status,
        "error": error,
    }


def update_download(
    dl_id: str,
    *,
    transferred: int | None = None,
    status: str | None = None,
    error: str | None = None,
) -> None:
    with _downloads_lock:
        record = _active_downloads.get(dl_id)
        if record is None:
            return
        if transferred is not None:
            record["transferred"] = transferred
        if status is not None:
            record["status"] = status
        if error is not None:
            record["error"] = error
        payload = download_payload(
            dl_id,
            record["key"],
            record["size"],
            record["transferred"],
            record["status"],
            record.get("error"),
        )
    socketio.emit("download_update", payload)


@app.get("/")
def index():
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")
    raw_prefix = request.args.get("prefix", "") or os.environ.get("B2_PREFIX", "")
    try:
        prefix = clean_prefix(raw_prefix)
    except argparse.ArgumentTypeError as exc:
        prefix = ""
        list_error = str(exc)
    else:
        list_error = None

    objects = []
    try:
        objects = list_objects(prefix)
    except (BotoCoreError, ClientError) as exc:
        list_error = str(exc)

    server_root_text, server_files = list_server_files()
    return render_template(
        "index.html",
        apikey=apikey,
        bucket=os.environ["B2_BUCKET"],
        default_prefix=os.environ.get("B2_PREFIX", ""),
        prefix=prefix,
        objects=objects,
        list_error=list_error,
        server_root=server_root_text,
        server_files=server_files,
        synced_files=recent_files(),
        bucket_private=BUCKET_PRIVATE,
        bucket_private_note=BUCKET_PRIVATE_NOTE,
        format_bytes=format_bytes,
        format_time=format_time,
    )


@app.post("/upload")
def upload():
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")

    file = request.files.get("file")
    if file is None or not file.filename:
        flash("请选择要上传的文件。", "error")
        return redirect(url_for("index", apikey=apikey))

    try:
        prefix = clean_prefix(request.form.get("prefix") or os.environ.get("B2_PREFIX", ""))
    except argparse.ArgumentTypeError as exc:
        flash(str(exc), "error")
        return redirect(url_for("index", apikey=apikey))

    filename = Path(file.filename.replace("\\", "/")).name
    object_key = "/".join(part for part in (prefix, filename) if part)
    incoming = UPLOAD_DIR / f"incoming-{secrets.token_hex(8)}.part"

    try:
        file.save(str(incoming))
        size = incoming.stat().st_size
        if size == 0:
            raise ValueError("文件内容为空。")
        with get_db() as conn:
            cursor = conn.execute(
                "INSERT INTO jobs (filename, object_key, size, status, created_at) "
                "VALUES (?, ?, ?, 'queued', ?)",
                (filename, object_key, size, time.time()),
            )
            job_id = cursor.lastrowid
        os.replace(incoming, UPLOAD_DIR / f"{job_id}.part")
    except (OSError, ValueError) as exc:
        incoming.unlink(missing_ok=True)
        flash(f"接收文件失败: {exc}", "error")
        return redirect(url_for("index", apikey=apikey))

    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    flash(f"「{filename}」已加入上传队列（{format_bytes(size)}）。", "ok")
    return redirect(url_for("index", apikey=apikey))


@app.post("/server-upload")
def server_upload():
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")
    raw_path = (request.form.get("path") or "").strip()
    try:
        prefix = clean_prefix(request.form.get("prefix") or os.environ.get("B2_PREFIX", ""))
    except argparse.ArgumentTypeError as exc:
        flash(str(exc), "error")
        return redirect(url_for("index", apikey=apikey))

    try:
        source = resolve_server_path(raw_path)
    except ValueError as exc:
        flash(str(exc), "error")
        return redirect(url_for("index", apikey=apikey))
    if not source.is_file():
        flash(f"路径不存在或不是普通文件: {source}", "error")
        return redirect(url_for("index", apikey=apikey))

    object_key = "/".join(part for part in (prefix, source.name) if part)
    size = source.stat().st_size
    job_id = insert_job(
        kind="upload",
        filename=source.name,
        object_key=object_key,
        size=size,
        source=str(source),
    )
    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    flash(f"「{source}」已加入上传队列（{format_bytes(size)}）。", "ok")
    return redirect(url_for("index", apikey=apikey))


@app.post("/server-download")
def server_download():
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")
    key = (request.form.get("key") or "").strip().lstrip("/")
    raw_destination = (request.form.get("destination") or "").strip()

    if not key:
        flash("请填写要下载的 bucket 对象名（key）。", "error")
        return redirect(url_for("index", apikey=apikey))
    try:
        destination = resolve_server_path(raw_destination)
    except ValueError as exc:
        flash(str(exc), "error")
        return redirect(url_for("index", apikey=apikey))
    if destination.is_dir():
        flash("目标路径是已存在的目录，请填写完整的文件路径。", "error")
        return redirect(url_for("index", apikey=apikey))

    try:
        metadata = get_client().head_object(Bucket=os.environ["B2_BUCKET"], Key=key)
        size = int(metadata["ContentLength"])
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in ("404", "NoSuchKey", "NotFound") or status == 404:
            flash(f"对象不存在: {key}", "error")
        else:
            flash(f"查询对象失败: {exc}", "error")
        return redirect(url_for("index", apikey=apikey))
    except (BotoCoreError, OSError) as exc:
        flash(f"查询对象失败: {exc}", "error")
        return redirect(url_for("index", apikey=apikey))

    job_id = insert_job(
        kind="download",
        filename=PurePosixPath(key).name or "download",
        object_key=key,
        size=size,
        destination=str(destination),
    )
    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    flash(f"「{key}」下载到 {destination} 的任务已加入队列。", "ok")
    return redirect(url_for("index", apikey=apikey))


@app.post("/url-upload")
def url_upload():
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")
    url = (request.form.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        flash("请填写以 http:// 或 https:// 开头的链接。", "error")
        return redirect(url_for("index", apikey=apikey))

    target = (request.form.get("target") or "bucket").strip()
    destination = None
    object_key = ""
    if target == "server":
        raw_destination = (request.form.get("destination") or "").strip()
        try:
            destination = resolve_server_path(raw_destination)
        except ValueError as exc:
            flash(str(exc), "error")
            return redirect(url_for("index", apikey=apikey))
        if destination.is_dir():
            flash("目标路径是已存在的目录，请填写完整的文件路径。", "error")
            return redirect(url_for("index", apikey=apikey))
    else:
        try:
            prefix = clean_prefix(request.form.get("prefix") or os.environ.get("B2_PREFIX", ""))
        except argparse.ArgumentTypeError as exc:
            flash(str(exc), "error")
            return redirect(url_for("index", apikey=apikey))
        filename = PurePosixPath(urlparse(url).path).name or "download"
        object_key = "/".join(part for part in (prefix, filename) if part)

    filename = PurePosixPath(urlparse(url).path).name or "download"
    job_id = insert_job(
        kind="fetch",
        filename=filename,
        object_key=object_key,
        size=0,
        source=url,
        destination=str(destination) if destination else None,
    )
    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    if destination:
        flash(f"「{url}」下载到 {destination} 的任务已加入队列。", "ok")
    else:
        flash(f"「{url}」抓取到 b2://{os.environ['B2_BUCKET']}/{object_key} 的任务已加入队列。", "ok")
    return redirect(url_for("index", apikey=apikey))


@app.get("/download")
def download():
    blocked = require_auth()
    if blocked:
        return blocked
    key = (request.args.get("key") or "").lstrip("/")
    if not key:
        return Response("400 缺少 key 参数", status=400)

    try:
        obj = get_client().get_object(Bucket=os.environ["B2_BUCKET"], Key=key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in ("404", "NoSuchKey", "NotFound") or status == 404:
            return Response(f"404 对象不存在: {key}", status=404)
        return Response(f"下载失败: {exc}", status=502)
    except (BotoCoreError, OSError) as exc:
        return Response(f"下载失败: {exc}", status=502)

    body = obj["Body"]
    filename = PurePosixPath(key).name or "download"
    size = obj.get("ContentLength") or 0
    dl_id = uuid.uuid4().hex
    with _downloads_lock:
        _active_downloads[dl_id] = {
            "key": key,
            "size": size,
            "transferred": 0,
            "status": "downloading",
            "error": None,
        }
    socketio.emit("download_update", download_payload(dl_id, key, size, 0, "downloading"))

    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
    }
    if obj.get("ContentLength") is not None:
        headers["Content-Length"] = str(obj["ContentLength"])
    if obj.get("ContentType"):
        headers["Content-Type"] = obj["ContentType"]

    def generate():
        transferred = 0
        last = 0.0
        try:
            for chunk in stream_body(body):
                transferred += len(chunk)
                now = time.monotonic()
                if now - last >= 0.5 or transferred >= size:
                    last = now
                    update_download(dl_id, transferred=transferred)
                yield chunk
            update_download(dl_id, transferred=size, status="done")
        except GeneratorExit:
            update_download(dl_id, status="failed", error="下载已取消")
            raise
        except Exception as exc:
            update_download(dl_id, status="failed", error=str(exc))
            raise
        finally:
            with _downloads_lock:
                _active_downloads.pop(dl_id, None)

    return Response(generate(), headers=headers)


@app.get("/api/jobs")
def api_jobs():
    blocked = require_auth()
    if blocked:
        return blocked
    return jsonify([job_payload(job) for job in recent_jobs()])


@app.get("/api/objects")
def api_objects():
    blocked = require_auth()
    if blocked:
        return blocked
    raw_prefix = request.args.get("prefix", "") or os.environ.get("B2_PREFIX", "")
    try:
        prefix = clean_prefix(raw_prefix)
    except argparse.ArgumentTypeError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        objects = list_objects(prefix)
    except (BotoCoreError, ClientError) as exc:
        return jsonify({"error": str(exc)}), 502
    return jsonify({"prefix": prefix, "objects": objects})


def main() -> int:
    parser = argparse.ArgumentParser(description="启动 B2 文件管理（开发模式）")
    parser.add_argument(
        "--reload",
        action="store_true",
        help="文件变更时自动重启（热加载），仅用于开发",
    )
    args = parser.parse_args()

    config_error = validate_config()
    if config_error:
        print(f"配置错误: {config_error}", file=sys.stderr)
        return 1

    init_runtime()

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    print(f"B2 文件管理已启动: http://{host}:{port}/?apikey=<APP_API_KEY>")
    socketio.run(app, host=host, port=port, use_reloader=args.reload)
    return 0


def init_runtime() -> None:
    """初始化运行环境：建表、恢复任务、清理残留分片、启动上传 worker。

    main()（开发模式）和 wsgi.py（gunicorn）都会调用；
    gunicorn 必须保持单 worker，保证上传队列在同一个进程内。
    """
    init_db()
    recover_jobs()
    cleanup_stale_multipart()
    threading.Thread(target=worker_loop, name="upload-worker", daemon=True).start()

    global BUCKET_PRIVATE, BUCKET_PRIVATE_NOTE
    BUCKET_PRIVATE, BUCKET_PRIVATE_NOTE = check_bucket_private()
    if BUCKET_PRIVATE is False:
        print(f"⚠️ 安全警告: {BUCKET_PRIVATE_NOTE}", file=sys.stderr)
    else:
        print(f"安全检测: {BUCKET_PRIVATE_NOTE}")


if __name__ == "__main__":
    raise SystemExit(main())
