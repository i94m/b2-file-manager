#!/usr/bin/env python3
"""B2 网页版上传/下载小工具。

- 配置：.env（参考 .env.example），Python 依赖由 uv 管理
- 鉴权：所有请求需带 ?apikey=<APP_API_KEY>
- 上传：文件先落盘到 tmp_uploads/，后台单线程队列上传，任务记录在 jobs.db
- 下载：从 B2 流式返回给浏览器
"""

from __future__ import annotations

import argparse
import os
import queue
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import quote

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


def format_bytes(value: float) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.2f} {unit}"
        value /= 1024
    return f"{value:.2f} TiB"


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
                filename TEXT NOT NULL,
                object_key TEXT NOT NULL,
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


def recent_jobs(limit: int = MAX_JOBS_SHOWN) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(row) for row in rows]


def job_payload(job: dict) -> dict:
    return {
        "id": job["id"],
        "filename": job["filename"],
        "object_key": job["object_key"],
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
            state["progress"] = min(size, state["progress"] + amount)
            now = time.monotonic()
            if now - state["last"] >= 0.5 or state["progress"] >= size:
                state["last"] = now
                with get_db() as conn:
                    conn.execute(
                        "UPDATE jobs SET progress=? WHERE id=?",
                        (state["progress"], job_id),
                    )
                emit_job_update(job_id)

    return callback


def process_job(job_id: int) -> None:
    temp_path = UPLOAD_DIR / f"{job_id}.part"
    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None or row["status"] != "queued":
            return
        conn.execute(
            "UPDATE jobs SET status='uploading', started_at=? WHERE id=?",
            (time.time(), job_id),
        )
        object_key = row["object_key"]
        size = row["size"]
    emit_job_update(job_id)

    try:
        get_client().upload_file(
            str(temp_path),
            os.environ["B2_BUCKET"],
            object_key,
            Callback=make_progress(job_id, size),
            Config=TRANSFER_CONFIG,
        )
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET status='done', progress=?, finished_at=? WHERE id=?",
                (size, time.time(), job_id),
            )
        emit_job_update(job_id)
    except (BotoCoreError, ClientError, OSError) as exc:
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?",
                (str(exc), time.time(), job_id),
            )
        emit_job_update(job_id)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass


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
    """重启恢复：上传中的任务标记失败并删除临时文件；排队中的任务继续处理。"""
    with get_db() as conn:
        interrupted = conn.execute("SELECT id FROM jobs WHERE status='uploading'").fetchall()
        for row in interrupted:
            (UPLOAD_DIR / f"{row['id']}.part").unlink(missing_ok=True)
            conn.execute(
                "UPDATE jobs SET status='failed', error='服务重启，上传中断，请重新上传', "
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


def list_objects(prefix: str) -> list[dict]:
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
            objects.append({"key": key, "size": int(item.get("Size", 0))})
    objects.sort(key=lambda obj: obj["key"])
    return objects


def stream_body(body, chunk_size: int = 1024 * 1024):
    try:
        while True:
            chunk = body.read(chunk_size)
            if not chunk:
                break
            yield chunk
    finally:
        body.close()


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

    return render_template(
        "index.html",
        apikey=apikey,
        bucket=os.environ["B2_BUCKET"],
        default_prefix=os.environ.get("B2_PREFIX", ""),
        prefix=prefix,
        objects=objects,
        list_error=list_error,
        format_bytes=format_bytes,
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
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
    }
    if obj.get("ContentLength") is not None:
        headers["Content-Length"] = str(obj["ContentLength"])
    if obj.get("ContentType"):
        headers["Content-Type"] = obj["ContentType"]
    return Response(stream_body(body), headers=headers)


@app.get("/api/jobs")
def api_jobs():
    blocked = require_auth()
    if blocked:
        return blocked
    return jsonify([job_payload(job) for job in recent_jobs()])


def main() -> int:
    config_error = validate_config()
    if config_error:
        print(f"配置错误: {config_error}", file=sys.stderr)
        return 1

    init_runtime()

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "5000"))
    print(f"B2 文件管理已启动: http://{host}:{port}/?apikey=<APP_API_KEY>")
    socketio.run(app, host=host, port=port)
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


if __name__ == "__main__":
    raise SystemExit(main())
