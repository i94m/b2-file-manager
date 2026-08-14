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
from db import get_db, Error as DBError
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
    request,
    send_file,
    url_for,
)
from flask_socketio import SocketIO, emit

from backblaze_upload import clean_prefix, normalize_endpoint

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "tmp_uploads"
MAX_JOBS_SHOWN = 50
DEFAULT_REGION = "us-east-1"
JOB_QUEUE: queue.Queue[int] = queue.Queue()
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "3"))

load_dotenv(BASE_DIR / ".env")

TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=100 * 1024 * 1024,
    multipart_chunksize=100 * 1024 * 1024,
    max_concurrency=4,
    use_threads=True,
)

app = Flask(__name__)
app.secret_key = secrets.token_hex(16)
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*")

_CLIENT = None
_BEIJING_CLIENT = None
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
    required_db = ("DB_HOST", "DB_USERNAME", "DB_DATABASE")
    missing_db = [name for name in required_db if not os.environ.get(name)]
    if missing_db:
        return "缺少数据库配置: " + ", ".join(missing_db)
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


def beijing_enabled() -> bool:
    """北京桶是否启用：3 个必填项都设置才算启用。"""
    return all(
        os.environ.get(name)
        for name in ("BEIJING_APPLICATION_KEY_ID", "BEIJING_APPLICATION_KEY", "BEIJING_BUCKET")
    )


def resolve_beijing_endpoint() -> tuple[str, str]:
    """解析 BEIJING_ENDPOINT / BEIJING_REGION（逻辑同 resolve_endpoint，读 BEIJING_* 变量）。"""
    endpoint = os.environ.get("BEIJING_ENDPOINT")
    region = os.environ.get("BEIJING_REGION")
    try:
        return normalize_endpoint(endpoint, region)
    except ValueError:
        if not endpoint:
            raise
        endpoint = endpoint.strip()
        if not endpoint.startswith(("https://", "http://")):
            endpoint = "https://" + endpoint
        return endpoint.rstrip("/"), region or DEFAULT_REGION


def get_beijing_client():
    """懒加载北京桶 S3 客户端（仅在 beijing_enabled() 时调用）。"""
    global _BEIJING_CLIENT
    if _BEIJING_CLIENT is None:
        endpoint, region = resolve_beijing_endpoint()
        _BEIJING_CLIENT = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=os.environ["BEIJING_APPLICATION_KEY_ID"],
            aws_secret_access_key=os.environ["BEIJING_APPLICATION_KEY"],
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "virtual"},
                retries={"max_attempts": 8, "mode": "standard"},
            ),
        )
    return _BEIJING_CLIENT


def resolve_bucket(target: str = "self") -> tuple:
    """统一获取 (client, bucket_name)。target="self" 用自己桶，"beijing" 用北京桶。"""
    if target == "beijing":
        if not beijing_enabled():
            raise ValueError("北京桶未启用")
        return get_beijing_client(), os.environ["BEIJING_BUCKET"]
    return get_client(), os.environ["B2_BUCKET"]


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


def resolve_local_path(raw: str) -> Path:
    """解析本地文件列表里的路径（相对 SERVER_FILE_ROOT 或绝对路径）并校验在目录内。

    列表接口返回的是相对路径（如 a.txt、sub/c.txt），下载/删除时直接用它。
    """
    if not raw or not raw.strip():
        raise ValueError("请输入路径")
    root = server_root()
    if root is None:
        raise ValueError("未配置 SERVER_FILE_ROOT")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    path = candidate.resolve()
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
# 数据库任务记录（MySQL via PyMySQL）
# --------------------------------------------------------------------------


def _drop_index_if_exists(conn, index_name, table_name):
    exists = conn.execute(
        "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
        (table_name, index_name),
    ).fetchone()
    if exists:
        conn.execute(f"DROP INDEX {index_name} ON {table_name}")


def _create_unique_index_if_not_exists(conn, index_name, table_name, columns):
    exists = conn.execute(
        "SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS "
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
        (table_name, index_name),
    ).fetchone()
    if not exists:
        conn.execute(f"CREATE UNIQUE INDEX {index_name} ON {table_name} ({columns})")


def init_db() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                kind VARCHAR(20) NOT NULL DEFAULT 'upload',
                filename VARCHAR(512) NOT NULL,
                object_key VARCHAR(1024) NOT NULL,
                source VARCHAR(1024),
                destination VARCHAR(1024),
                size BIGINT NOT NULL DEFAULT 0,
                status VARCHAR(20) NOT NULL DEFAULT 'queued',
                progress BIGINT NOT NULL DEFAULT 0,
                error TEXT,
                created_at DOUBLE NOT NULL,
                started_at DOUBLE,
                finished_at DOUBLE,
                note TEXT,
                cancelled TINYINT NOT NULL DEFAULT 0,
                paused TINYINT NOT NULL DEFAULT 0
            )
            """
        )
        # 兼容旧库：补齐新增列
        columns = {row["Field"] for row in conn.execute("SHOW COLUMNS FROM jobs")}
        for name, definition in (
            ("kind", "VARCHAR(20) NOT NULL DEFAULT 'upload'"),
            ("source", "VARCHAR(1024)"),
            ("destination", "VARCHAR(1024)"),
            ("note", "TEXT"),
            ("cancelled", "TINYINT NOT NULL DEFAULT 0"),
            ("paused", "TINYINT NOT NULL DEFAULT 0"),
        ):
            if name not in columns:
                conn.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")
        # 数据源表（原 scripts，已改名/改字段）：
        #   name        数据源名称
        #   script_path 脚本路径（允许空，仅记录备注，系统不执行）
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS datasources (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(255) NOT NULL,
                script_path VARCHAR(1024),
                description TEXT,
                created_at DOUBLE NOT NULL,
                updated_at DOUBLE NOT NULL
            )
            """
        )
        # 旧库迁移：把旧 scripts 表的数据搬到 datasources（command → script_path）
        has_old_scripts = conn.execute(
            "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scripts'"
        ).fetchone()
        if has_old_scripts:
            old_count = conn.execute("SELECT COUNT(*) AS c FROM scripts").fetchone()["c"]
            if old_count > 0:
                conn.execute(
                    "INSERT IGNORE INTO datasources (id, name, script_path, description, created_at, updated_at) "
                    "SELECT id, name, command, description, created_at, updated_at FROM scripts"
                )
            conn.execute("DROP TABLE scripts")
        # 检查 files 表是否存在（SHOW COLUMNS 在表不存在时会报错）
        files_exists = conn.execute(
            "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'files'"
        ).fetchone()
        if files_exists:
            file_info = conn.execute("SHOW COLUMNS FROM files").fetchall()
            file_columns = {row["Field"] for row in file_info}
            md5_col = next((row for row in file_info if row["Field"] == "md5"), None)
        else:
            file_info = []
            file_columns = set()
            md5_col = None
        files_ddl = """
            CREATE TABLE files (
                id INT PRIMARY KEY AUTO_INCREMENT,
                job_id INT,
                object_key VARCHAR(1024) NOT NULL,
                filename VARCHAR(512),
                md5 VARCHAR(32),
                size BIGINT NOT NULL DEFAULT 0,
                bucket VARCHAR(255) NOT NULL DEFAULT '',
                source_url VARCHAR(2048),
                uploaded TINYINT NOT NULL DEFAULT 0,
                uploaded_beijing TINYINT NOT NULL DEFAULT 0,
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                datasource_id INT,
                local_path VARCHAR(1024),
                created_at DOUBLE NOT NULL,
                updated_at DOUBLE NOT NULL,
                synced_at DOUBLE,
                error TEXT
            )
        """
        if md5_col is not None and md5_col["Null"] == "NO":
            # 旧版 files 表：md5 NOT NULL。重建为可空（pending 记录先无 md5），并保留已有数据。
            _drop_index_if_exists(conn, "idx_files_md5", "files")
            _drop_index_if_exists(conn, "idx_files_job", "files")
            conn.execute("ALTER TABLE files RENAME TO files_old")
            old_columns = {row["Field"] for row in conn.execute("SHOW COLUMNS FROM files_old")}

            def src(name: str, fallback: str) -> str:
                return name if name in old_columns else fallback

            conn.execute(files_ddl)
            empty_bucket = "''"
            conn.execute(
                "INSERT INTO files "
                "(id, job_id, object_key, filename, md5, size, bucket, source_url, "
                " uploaded, status, datasource_id, created_at, updated_at, synced_at, error) "
                f"SELECT id, {src('job_id', 'NULL')}, object_key, filename, md5, size, "
                f"{src('bucket', empty_bucket)}, source_url, {src('uploaded', '0')}, status, "
                f"{src('datasource_id', src('script_id', 'NULL'))}, created_at, "
                f"{src('updated_at', 'created_at')}, synced_at, error FROM files_old"
            )
            conn.execute("DROP TABLE files_old")
        else:
            conn.execute(files_ddl.replace("CREATE TABLE files", "CREATE TABLE IF NOT EXISTS files", 1))
            # 建表后重新读取列（file_columns 是建表前的快照，全新库时为空集，
            # 不重读会导致对已存在列重复 ADD COLUMN 而报 duplicate column name）
            file_columns = {row["Field"] for row in conn.execute("SHOW COLUMNS FROM files")}
            for name, definition in (
                ("job_id", "INT"),
                ("md5", "VARCHAR(32)"),
                ("bucket", "VARCHAR(255) NOT NULL DEFAULT ''"),
                ("uploaded", "TINYINT NOT NULL DEFAULT 0"),
                ("uploaded_beijing", "TINYINT NOT NULL DEFAULT 0"),
                ("datasource_id", "INT"),
                ("local_path", "VARCHAR(1024)"),
                ("updated_at", "DOUBLE"),
            ):
                if name not in file_columns:
                    conn.execute(f"ALTER TABLE files ADD COLUMN {name} {definition}")
            # 旧库迁移：把 script_id 的数据迁到 datasource_id
            if "datasource_id" not in file_columns and "script_id" in file_columns:
                conn.execute("UPDATE files SET datasource_id = script_id WHERE script_id IS NOT NULL")
        _create_unique_index_if_not_exists(conn, "idx_files_md5", "files", "md5")
        _create_unique_index_if_not_exists(conn, "idx_files_job", "files", "job_id")
        conn.execute(
            "UPDATE files SET uploaded=1, status='synced', "
            "updated_at=COALESCE(updated_at, created_at), "
            "bucket=COALESCE(NULLIF(bucket, ''), ?) WHERE uploaded=1 OR status='synced'",
            (os.environ.get("B2_BUCKET", ""),),
        )


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


def bucket_prefix() -> str:
    """读取并清洗 BUCKET_PREFIX，默认 files/。

    所有上传对象 key 都会前置该前缀，便于在同一个 bucket 中隔离本应用的数据。
    变量缺省时用默认值 files/；显式设为空字符串则不添加前缀。
    """
    return clean_prefix(os.environ.get("BUCKET_PREFIX", "files/"))


def default_prefix() -> str:
    """表单「前缀」输入框的默认值。

    优先读 DEFAULT_PREFIX；旧配置名 B2_PREFIX 仍向后兼容。
    与 bucket_prefix() 的区别：
      - bucket_prefix()：全局固定的应用隔离前缀，不暴露给用户、不可在表单覆盖；
      - default_prefix()：仅作为表单默认值，用户上传/录入时可随意修改。
    两者最终在 build_object_key() 拼接为：BUCKET_PREFIX/<default_prefix>/<原始文件名>
    """
    return os.environ.get("DEFAULT_PREFIX") or os.environ.get("B2_PREFIX", "")


def build_object_key(prefix: str, filename: str) -> str:
    """生成 BUCKET_PREFIX/<prefix>/<原始文件名> 的对象 key，保留原始文件名。"""
    parts = [p for p in (bucket_prefix(), prefix, filename) if p]
    return "/".join(parts)


def object_exists(client, bucket_name: str, object_key: str) -> bool:
    """head_object 成功即存在；404/NotFound 视为不存在；其它异常抛出。"""
    try:
        client.head_object(Bucket=bucket_name, Key=object_key)
        return True
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            return False
        raise


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
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "cancelled": bool(job.get("cancelled", 0)),
        "paused": bool(job.get("paused", 0)),
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

class JobCancelled(Exception):
    """任务被用户取消时抛出，用于中止 boto3 传输。"""


# 进程内已请求取消的 job_id 集合。worker 传输回调每块检查它（比查 DB 快），
# 命中则抛 JobCancelled 中止 boto3 传输。cancel 接口写入，worker 收尾时移除。
_CANCELLED: set[int] = set()
_CANCELLED_LOCK = threading.Lock()


def request_cancel(job_id: int) -> None:
    """请求取消一个 job：标记内存集合 + 更新 DB。"""
    with _CANCELLED_LOCK:
        _CANCELLED.add(job_id)
    with get_db() as conn:
        conn.execute("UPDATE jobs SET cancelled=1 WHERE id=?", (job_id,))


def is_cancelled(job_id: int) -> bool:
    return job_id in _CANCELLED


def clear_cancel(job_id: int) -> None:
    with _CANCELLED_LOCK:
        _CANCELLED.discard(job_id)


# 暂停基础设施：用 threading.Event 实现阻塞/唤醒。
# set() = 放行（未暂停），clear() = 阻塞（已暂停）。
_PAUSED: set[int] = set()
_PAUSED_LOCK = threading.Lock()
_PAUSE_EVENTS: dict[int, threading.Event] = {}


def _get_pause_event(job_id: int) -> threading.Event:
    with _PAUSED_LOCK:
        ev = _PAUSE_EVENTS.get(job_id)
        if ev is None:
            ev = threading.Event()
            ev.set()  # 初始：未暂停（set = 放行）
            _PAUSE_EVENTS[job_id] = ev
        return ev


def request_pause(job_id: int) -> None:
    with _PAUSED_LOCK:
        _PAUSED.add(job_id)
    _get_pause_event(job_id).clear()  # clear = 阻塞


def request_resume(job_id: int) -> None:
    with _PAUSED_LOCK:
        _PAUSED.discard(job_id)
    _get_pause_event(job_id).set()  # set = 放行


def is_paused(job_id: int) -> bool:
    return job_id in _PAUSED


def wait_if_paused(job_id: int) -> None:
    """暂停时阻塞，每 0.5s 醒来检查取消标志。"""
    while is_paused(job_id):
        _get_pause_event(job_id).wait(timeout=0.5)
        if is_cancelled(job_id):
            raise JobCancelled(f"任务 {job_id} 暂停期间被取消")


def clear_pause(job_id: int) -> None:
    with _PAUSED_LOCK:
        _PAUSED.discard(job_id)
        _PAUSE_EVENTS.pop(job_id, None)


def make_progress(job_id: int, size: int):
    lock = threading.Lock()
    state = {"progress": 0, "last": 0.0}

    def callback(amount: int) -> None:
        # 每块传输前检查取消标志，命中即中止传输
        if is_cancelled(job_id):
            raise JobCancelled(f"任务 {job_id} 已取消")
        wait_if_paused(job_id)  # 暂停时阻塞，恢复后继续
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


def upload_to_bucket(source: Path, object_key: str, job_id: int, size: int,
                     client=None, bucket_name: str | None = None) -> None:
    if client is None:
        client = get_client()
    if bucket_name is None:
        bucket_name = os.environ["B2_BUCKET"]
    client.upload_file(
        str(source),
        bucket_name,
        object_key,
        Callback=make_progress(job_id, size),
        Config=TRANSFER_CONFIG,
    )


def download_to_path(object_key: str, size: int, destination: Path, job_id: int,
                     client=None, bucket_name: str | None = None) -> None:
    if client is None:
        client = get_client()
    if bucket_name is None:
        bucket_name = os.environ["B2_BUCKET"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".part", dir=str(destination.parent)
    )
    os.close(fd)
    completed = False
    try:
        client.download_file(
            bucket_name,
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
    """从 URL 流式下载到系统临时目录（/tmp），返回（临时路径, 文件大小, md5）。

    上传到 bucket 后由 cleanup_job_temp 清理该临时文件。
    """
    request = Request(url, headers={"User-Agent": "b2-file-manager/0.1"})
    temp_path = Path(tempfile.gettempdir()) / f"b2-fetch-{job_id}.part"
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


def ensure_unique_md5(md5: str, job_id: int, uploaded_column: str = "uploaded") -> bool:
    """md5 已存在时跳过上传并给任务加备注，返回是否为新文件。

    只有 uploaded_column=1（实际上传成功）的记录才算数，避免中断/失败的残留记录
    导致后续相同文件被误判为"已存在"而跳过上传。
    """
    # uploaded_column 受控于代码内部调用，非用户输入，可安全拼接
    with get_db() as conn:
        row = conn.execute(
            f"SELECT object_key FROM files WHERE md5=? AND job_id <> ? AND {uploaded_column}=1",
            (md5, job_id),
        ).fetchone()
    if row is not None:
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET note=? WHERE id=?",
                (f"md5 已存在，跳过上传（已存于 {row['object_key']}）", job_id),
            )
        emit_job_update(job_id)
        return False
    return True


def verify_object(object_key: str, size: int, client=None, bucket_name: str | None = None) -> None:
    if client is None:
        client = get_client()
    if bucket_name is None:
        bucket_name = os.environ["B2_BUCKET"]
    meta = client.head_object(Bucket=bucket_name, Key=object_key)
    actual = int(meta["ContentLength"])
    if actual != size:
        raise OSError(f"上传校验失败：bucket 中 {actual} 字节，本地 {size} 字节")


def insert_file_pending(
    *,
    job_id: int | None = None,
    object_key: str,
    filename: str,
    size: int,
    source_url: str | None = None,
    datasource_id: int | None = None,
) -> int:
    """登记一条 pending 记录，后续由 worker 逐步更新。

    job_id 为空时表示「只登记未上传」（用户稍后手动触发上传），
    返回新插入的 file id。
    """
    now = time.time()
    with get_db() as conn:
        cursor = conn.execute(
            "INSERT INTO files (job_id, object_key, filename, size, bucket, source_url, datasource_id, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            (
                job_id,
                object_key,
                filename,
                size,
                os.environ.get("B2_BUCKET", ""),
                source_url,
                datasource_id,
                now,
                now,
            ),
        )
        return int(cursor.lastrowid)


def update_file_by_job(job_id: int, **fields) -> None:
    if not fields:
        return
    fields["updated_at"] = time.time()
    sets = ", ".join(f"{name}=?" for name in fields)
    values = list(fields.values()) + [job_id]
    with get_db() as conn:
        conn.execute(f"UPDATE files SET {sets} WHERE job_id=?", values)


def sync_to_bucket(
    source_path: Path,
    object_key: str,
    job_id: int,
    size: int,
    md5: str,
    filename: str | None = None,
    source_url: str | None = None,
    client=None,
    bucket_name: str | None = None,
    uploaded_column: str = "uploaded",
) -> bool:
    """上传到 bucket 并更新 files 记录；md5 重复时删除 pending 记录并跳过。

    uploaded_column 控制成功后写哪个字段（"uploaded" 或 "uploaded_beijing"）。
    """
    if not ensure_unique_md5(md5, job_id, uploaded_column):
        with get_db() as conn:
            conn.execute("DELETE FROM files WHERE job_id=?", (job_id,))
        return False
    update_file_by_job(job_id, size=size, md5=md5)
    upload_to_bucket(source_path, object_key, job_id, size, client=client, bucket_name=bucket_name)
    verify_object(object_key, size, client=client, bucket_name=bucket_name)
    now = time.time()
    with get_db() as conn:
        conn.execute(
            f"UPDATE files SET md5=?, size=?, {uploaded_column}=1, status='synced', synced_at=?, updated_at=? "
            "WHERE job_id=?",
            (md5, size, now, now, job_id),
        )
    return True


def cleanup_job_temp(job_id: int, kind: str, destination: str | None = None) -> None:
    """清理任务产生的临时文件（服务器路径上传任务的源文件不属于临时文件）。"""
    if kind in ("download", "download_beijing") and destination:
        try:
            dest = Path(destination)
            for leftover in dest.parent.glob(f".{dest.name}.*.part"):
                leftover.unlink(missing_ok=True)
        except OSError:
            pass
    else:
        # 同时清理新路径（/tmp/b2-fetch-*）与旧路径（tmp_uploads/*.part），兼容两种来源
        try:
            (Path(tempfile.gettempdir()) / f"b2-fetch-{job_id}.part").unlink(missing_ok=True)
        except OSError:
            pass
        try:
            (UPLOAD_DIR / f"{job_id}.part").unlink(missing_ok=True)
        except OSError:
            pass


def process_job(job_id: int) -> None:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None or row["status"] != "queued":
            return
        if is_paused(job_id):
            # 暂停的排队任务跳过（恢复时由 resume 端点重新入队）
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
        filename = row["filename"]
    emit_job_update(job_id)

    try:
        if kind in ("download", "download_beijing"):
            client, bucket = resolve_bucket("beijing" if kind == "download_beijing" else "self")
            download_to_path(object_key, size, Path(destination), job_id,
                             client=client, bucket_name=bucket)
            # 若该 job 关联了 file 记录（从文件列表「下载到服务器」发起），
            # 成功后回写 local_path（相对 SERVER_FILE_ROOT 的路径）作为已下载标识
            with get_db() as conn:
                linked = conn.execute(
                    "SELECT id FROM files WHERE job_id=? LIMIT 1", (job_id,)
                ).fetchone()
            if linked is not None:
                root = server_root()
                if root is not None:
                    try:
                        rel = Path(destination).resolve().relative_to(root).as_posix()
                    except ValueError:
                        rel = Path(destination).name
                else:
                    rel = Path(destination).name
                update_file_by_job(job_id, local_path=rel)
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
                    update_file_by_job(job_id, size=size, md5=md5)
                    dest = Path(destination)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(source_path), dest)
                    # 回写 local_path（相对 SERVER_FILE_ROOT）作为已下载标识
                    root = server_root()
                    if root is not None:
                        try:
                            rel = dest.resolve().relative_to(root).as_posix()
                        except ValueError:
                            rel = dest.name
                    else:
                        rel = dest.name
                    update_file_by_job(job_id, local_path=rel)
                else:
                    sync_to_bucket(source_path, object_key, job_id, size, md5, filename, source)
            elif kind in ("upload", "upload_beijing"):
                client, bucket = resolve_bucket("beijing" if kind == "upload_beijing" else "self")
                col = "uploaded_beijing" if kind == "upload_beijing" else "uploaded"
                if source_path is None:
                    source_path = UPLOAD_DIR / f"{job_id}.part"
                md5 = hash_file(source_path)
                sync_to_bucket(source_path, object_key, job_id, size, md5, filename,
                               client=client, bucket_name=bucket, uploaded_column=col)
            else:
                # 兜底：兼容旧版 upload（无 _beijing 后缀）
                if source_path is None:
                    source_path = UPLOAD_DIR / f"{job_id}.part"
                md5 = hash_file(source_path)
                sync_to_bucket(source_path, object_key, job_id, size, md5, filename)
            final_size = size
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET status='done', progress=?, finished_at=? WHERE id=?",
                (final_size, time.time(), job_id),
            )
        emit_job_update(job_id)
    except JobCancelled:
        # 用户取消：标记 cancelled，清理临时文件与 B2 分片
        update_file_by_job(job_id, status="cancelled", error="任务已取消")
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET status='cancelled', error='任务已取消', finished_at=? WHERE id=?",
                (time.time(), job_id),
            )
        emit_job_update(job_id)
    except (BotoCoreError, ClientError, OSError, ValueError, TimeoutError, TypeError) as exc:
        update_file_by_job(job_id, status="failed", error=str(exc))
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET status='failed', error=?, finished_at=? WHERE id=?",
                (str(exc), time.time(), job_id),
            )
        emit_job_update(job_id)
    finally:
        cleanup_job_temp(job_id, kind, destination)
        clear_cancel(job_id)
        clear_pause(job_id)


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
    # 重启后内存 _PAUSED 清空，DB 中残留的 paused=1 无意义，重置为 0
    with get_db() as conn:
        conn.execute("UPDATE jobs SET paused=0 WHERE paused=1")
        interrupted = conn.execute("SELECT * FROM jobs WHERE status='uploading'").fetchall()
        interrupted = conn.execute("SELECT * FROM jobs WHERE status='uploading'").fetchall()
        for row in interrupted:
            cleanup_job_temp(row["id"], row["kind"], row["destination"])
            update_file_by_job(row["id"], status="failed", error="服务重启，任务中断")
            conn.execute(
                "UPDATE jobs SET status='failed', error='服务重启，任务中断，请重新提交', "
                "finished_at=? WHERE id=?",
                (time.time(), row["id"]),
            )
        pending = conn.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY id").fetchall()
    for row in pending:
        JOB_QUEUE.put(row["id"])


def cleanup_stale_multipart(max_age_hours: float = 24.0, client=None, bucket_name: str | None = None) -> None:
    """清理 B2 中超过阈值仍未完成的分片上传（进程崩溃时的残留兜底）。"""
    if client is None:
        client = get_client()
    if bucket_name is None:
        bucket_name = os.environ["B2_BUCKET"]
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
        count = 0
        paginator = client.get_paginator("list_multipart_uploads")
        for page in paginator.paginate(Bucket=bucket_name):
            for upload in page.get("Uploads", []):
                initiated = upload.get("Initiated")
                if initiated is None:
                    continue
                if initiated.tzinfo is None:
                    initiated = initiated.replace(tzinfo=timezone.utc)
                if initiated < cutoff:
                    client.abort_multipart_upload(
                        Bucket=bucket_name,
                        Key=upload["Key"],
                        UploadId=upload["UploadId"],
                    )
                    count += 1
        if count:
            print(f"已清理 {count} 个超过 {max_age_hours:.0f} 小时未完成的分片上传。")
    except (BotoCoreError, ClientError) as exc:
        print(f"清理未完成分片上传失败（可忽略）: {exc}")


def recent_files(limit: int = 500) -> list[dict]:
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM files ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(row) for row in rows]


def recent_scripts() -> list[dict]:
    """数据源列表（原 scripts 表）。"""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM datasources ORDER BY id DESC").fetchall()
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


def check_bucket_health(client, bucket_name: str, endpoint: str, addressing: str) -> dict:
    """检测桶连通性 + 元数据 / 诊断信息。

    每个字段独立容错：单个 API 失败不影响其它字段。
    - head_bucket：可达性 + 延迟 + 响应头里的 region / 冗余 / 存储类
    - get_bucket_location：region（比 head_bucket 头更权威）
    - get_bucket_versioning：版本控制状态
    - get_bucket_acl：是否公开读（含 AllUsers）
    """
    result: dict = {
        "ok": None,
        "error": None,
        "latency_ms": None,
        "status_code": None,
        "endpoint": endpoint,
        "addressing_style": addressing,
        "region": None,
        "versioning": None,
        "public": None,
        "redundancy": None,
        "storage_class": None,
    }

    # head_bucket：可达性 + 延迟 + 响应头
    try:
        t0 = time.time()
        resp = client.head_bucket(Bucket=bucket_name)
        result["latency_ms"] = int((time.time() - t0) * 1000)
        meta = resp.get("ResponseMetadata", {})
        result["status_code"] = meta.get("HTTPStatusCode")
        headers = meta.get("HTTPHeaders", {}) or {}
        result["redundancy"] = headers.get("x-amz-az-redundancy")
        result["storage_class"] = headers.get("x-amz-storage-class")
        result["region"] = headers.get("x-amz-bucket-region")
        result["ok"] = True
    except (BotoCoreError, ClientError) as exc:
        result["ok"] = False
        result["error"] = str(exc)
        return result  # 连不通则不再查询其它字段

    # get_bucket_location
    try:
        loc = client.get_bucket_location(Bucket=bucket_name)
        constraint = loc.get("LocationConstraint")
        if constraint:
            result["region"] = constraint
    except (BotoCoreError, ClientError):
        pass

    # get_bucket_versioning
    try:
        ver = client.get_bucket_versioning(Bucket=bucket_name)
        result["versioning"] = ver.get("Status") or "Disabled"
    except (BotoCoreError, ClientError):
        pass

    # get_bucket_acl：是否公开读
    try:
        acl = client.get_bucket_acl(Bucket=bucket_name)
        is_public = any(
            "AllUsers" in (g.get("Grantee", {}).get("URI", "") or "")
            for g in acl.get("Grants", [])
        )
        result["public"] = is_public
    except (BotoCoreError, ClientError):
        pass

    return result


# --------------------------------------------------------------------------
# Flask 路由
# --------------------------------------------------------------------------

def apikey_ok() -> bool:
    """检查 apikey：支持 query param、X-API-Key header、Authorization Bearer。"""
    expected = os.environ.get("APP_API_KEY", "")
    if not expected:
        return False
    provided = request.args.get("apikey", "")
    if not provided:
        provided = request.headers.get("X-API-Key", "")
    if not provided:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            provided = auth[7:]
    return bool(provided) and secrets.compare_digest(provided, expected)


def require_auth():
    if not apikey_ok():
        if wants_json():
            return jsonify({"error": "未授权"}), 401
        return Response("401 未授权", status=401)
    return None


def wants_json() -> bool:
    """判断是否返回 JSON 响应。

    - Accept: application/json → JSON（React fetch、机器人）
    - 无 Accept 或 Accept: */* → JSON（机器人/curl 默认）
    - Accept: text/html... → redirect（旧浏览器表单）
    """
    accept = request.headers.get("Accept", "")
    if not accept or "application/json" in accept or accept.strip() == "*/*":
        return True
    return False


def respond(status: str, message: str, apikey: str, category: str = "ok",
            code: int = 200, **extra):
    """统一封装「表单提交类」路由的成功/失败响应。

    - JSON 请求（React）：返回 JSON，不跳转。
    - 表单请求（旧）：flash 消息并 redirect 回首页。
    """
    if wants_json():
        payload = {"status": status, "message": message}
        payload.update(extra)
        return jsonify(payload), code
    flash(message, category)
    return redirect(url_for("index", apikey=apikey))


@socketio.on("connect")
def socket_connect():
    if not apikey_ok():
        return False
    emit("jobs_snapshot", [job_payload(job) for job in recent_jobs()])


def list_objects(prefix: str, limit: int | None = 50, client=None, bucket_name: str | None = None) -> list[dict]:
    prefix = prefix.strip("/")
    if prefix:
        prefix += "/"
    objects: list[dict] = []
    if client is None:
        client = get_client()
    if bucket_name is None:
        bucket_name = os.environ["B2_BUCKET"]
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
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
    if limit is not None:
        objects = objects[:limit]
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
    """根路由：前端已由 React (Vite) 接管，Flask 仅提供 /api/* 等接口。

    这里返回最小引导信息（鉴权后），便于直接 curl 探活；
    页面本身由 Vite dev server（开发）或 nginx 托管的 dist/（生产）提供。
    """
    blocked = require_auth()
    if blocked:
        return blocked
    return jsonify({
        "app": "b2-file-manager",
        "bucket": os.environ["B2_BUCKET"],
        "default_prefix": default_prefix(),
        "bucket_private": BUCKET_PRIVATE,
        "bucket_private_note": BUCKET_PRIVATE_NOTE,
        "endpoints": [
            "GET /api/files",
            "GET /api/scripts",
            "GET /api/jobs",
            "GET /api/objects",
            "POST /api/submit",
            "POST /upload",
            "GET /download",
        ],
    })


@app.post("/upload")
def upload():
    """上传本地文件到 bucket。

    表单字段：file（必填）、prefix（可选）、key（可选，自定义完整 object key）、
    bucket（可选，self|beijing）、datasource_id（可选）。
    React (Accept: application/json) 调用时返回 JSON，旧表单则 flash + redirect。
    """
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")

    file = request.files.get("file")
    if file is None or not file.filename:
        return respond("error", "请选择要上传的文件。", apikey, "error", 400)

    filename = Path(file.filename.replace("\\", "/")).name

    # 目标桶：self（默认）或 beijing
    bucket = (request.form.get("bucket") or "self").strip()
    if bucket == "beijing":
        if not beijing_enabled():
            return respond("error", "北京桶未启用。", apikey, "error", 400)
        kind = "upload_beijing"
    else:
        bucket = "self"
        kind = "upload"

    # 自定义完整 key 优先；否则按 prefix 生成 key（保留原始文件名）
    custom_key = (request.form.get("key") or "").strip().lstrip("/")
    if custom_key:
        object_key = custom_key
    else:
        try:
            prefix = clean_prefix(request.form.get("prefix") or default_prefix())
        except argparse.ArgumentTypeError as exc:
            return respond("error", str(exc), apikey, "error", 400)
        object_key = build_object_key(prefix, filename)

    # 同名拒传：目标 key 已存在则报错，不创建 job、不入队
    client, bucket_name = resolve_bucket(bucket)
    if object_exists(client, bucket_name, object_key):
        return respond("error", f"同名文件已存在：{object_key}", apikey, "error", 400)

    datasource_id = request.form.get("datasource_id", type=int)
    incoming = UPLOAD_DIR / f"incoming-{secrets.token_hex(8)}.part"

    try:
        file.save(str(incoming))
        size = incoming.stat().st_size
        if size == 0:
            raise ValueError("文件内容为空。")
        with get_db() as conn:
            cursor = conn.execute(
                "INSERT INTO jobs (kind, filename, object_key, size, status, created_at) "
                "VALUES (?, ?, ?, ?, 'queued', ?)",
                (kind, filename, object_key, size, time.time()),
            )
            job_id = cursor.lastrowid
        os.replace(incoming, UPLOAD_DIR / f"{job_id}.part")
        insert_file_pending(
            job_id=job_id,
            object_key=object_key,
            filename=filename,
            size=size,
            datasource_id=datasource_id,
        )
    except (OSError, ValueError, DBError) as exc:
        incoming.unlink(missing_ok=True)
        return respond("error", f"接收文件失败: {exc}", apikey, "error", 500)

    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    return respond(
        "ok", f"「{filename}」已加入上传队列（{format_bytes(size)}）。", apikey,
        job_id=job_id, object_key=object_key, filename=filename, size=size,
    )


@app.post("/server-upload")
def server_upload():
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")
    raw_path = (request.form.get("path") or "").strip()
    try:
        prefix = clean_prefix(request.form.get("prefix") or default_prefix())
    except argparse.ArgumentTypeError as exc:
        return respond("error", str(exc), apikey, "error", 400)

    try:
        source = resolve_server_path(raw_path)
    except ValueError as exc:
        return respond("error", str(exc), apikey, "error", 400)
    if not source.is_file():
        return respond("error", f"路径不存在或不是普通文件: {source}", apikey, "error", 400)

    object_key = build_object_key(prefix, source.name)
    # 同名拒传
    if object_exists(get_client(), os.environ["B2_BUCKET"], object_key):
        return respond("error", f"同名文件已存在：{object_key}", apikey, "error", 400)
    size = source.stat().st_size
    datasource_id = request.form.get("datasource_id", type=int)
    job_id = insert_job(
        kind="upload",
        filename=source.name,
        object_key=object_key,
        size=size,
        source=str(source),
    )
    insert_file_pending(
        job_id=job_id,
        object_key=object_key,
        filename=source.name,
        size=size,
        datasource_id=datasource_id,
    )
    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    return respond(
        "ok", f"「{source}」已加入上传队列（{format_bytes(size)}）。", apikey,
        job_id=job_id, object_key=object_key, filename=source.name, size=size,
    )


@app.post("/server-download")
def server_download():
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")
    key = (request.form.get("key") or "").strip().lstrip("/")
    raw_destination = (request.form.get("destination") or "").strip()

    if not key:
        return respond("error", "请填写要下载的 bucket 对象名（key）。", apikey, "error", 400)
    try:
        destination = resolve_server_path(raw_destination)
    except ValueError as exc:
        return respond("error", str(exc), apikey, "error", 400)
    if destination.is_dir():
        return respond("error", "目标路径是已存在的目录，请填写完整的文件路径。", apikey, "error", 400)

    try:
        metadata = get_client().head_object(Bucket=os.environ["B2_BUCKET"], Key=key)
        size = int(metadata["ContentLength"])
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in ("404", "NoSuchKey", "NotFound") or status == 404:
            msg = f"对象不存在: {key}"
        else:
            msg = f"查询对象失败: {exc}"
        return respond("error", msg, apikey, "error", 400)
    except (BotoCoreError, OSError) as exc:
        return respond("error", f"查询对象失败: {exc}", apikey, "error", 400)

    job_id = insert_job(
        kind="download",
        filename=PurePosixPath(key).name or "download",
        object_key=key,
        size=size,
        destination=str(destination),
    )
    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    return respond(
        "ok", f"「{key}」下载到 {destination} 的任务已加入队列。", apikey,
        job_id=job_id, object_key=key, size=size,
    )


@app.get("/api/server-files")
def api_server_files():
    """本地文件列表（SERVER_FILE_ROOT 目录），含总大小。

    返回：
        {
          "root": "/abs/path",        // 目录路径；未配置 SERVER_FILE_ROOT 时为 null
          "total_size": 123456,       // 所有文件字节数总和
          "files": [ {"path": "...", "size": 123, "absolute": "/abs"} ]
        }
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    root, files = list_server_files()
    if root is None:
        return jsonify({"root": None, "total_size": 0, "files": []})
    return jsonify({
        "root": root,
        "total_size": sum(f["size"] for f in files),
        "files": files,
    })


@app.get("/server-file/download")
def server_file_download():
    """把 SERVER_FILE_ROOT 里的文件通过浏览器下载到用户电脑。"""
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    raw = (request.args.get("path") or "").strip()
    try:
        path = resolve_local_path(raw)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not path.is_file():
        return jsonify({"error": f"文件不存在: {raw}"}), 404
    return send_file(
        path,
        as_attachment=True,
        download_name=path.name,
    )


@app.delete("/api/server-files")
def api_server_file_delete():
    """删除 SERVER_FILE_ROOT 里的一个本地文件。"""
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    raw = (request.args.get("path") or "").strip()
    try:
        path = resolve_local_path(raw)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not path.is_file():
        return jsonify({"error": f"文件不存在: {path}"}), 404
    try:
        path.unlink()
    except OSError as exc:
        return jsonify({"error": f"删除失败: {exc}"}), 500
    return jsonify({"deleted": True, "path": raw})


@app.post("/url-upload")
def url_upload():
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")
    url = (request.form.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        return respond("error", "请填写以 http:// 或 https:// 开头的链接。", apikey, "error", 400)

    target = (request.form.get("target") or "bucket").strip()
    destination = None
    object_key = ""
    datasource_id = request.form.get("datasource_id", type=int)
    if target == "server":
        raw_destination = (request.form.get("destination") or "").strip()
        try:
            destination = resolve_server_path(raw_destination)
        except ValueError as exc:
            return respond("error", str(exc), apikey, "error", 400)
        if destination.is_dir():
            return respond("error", "目标路径是已存在的目录，请填写完整的文件路径。", apikey, "error", 400)
    else:
        try:
            prefix = clean_prefix(request.form.get("prefix") or default_prefix())
        except argparse.ArgumentTypeError as exc:
            return respond("error", str(exc), apikey, "error", 400)
        filename = PurePosixPath(urlparse(url).path).name or "download"
        object_key = build_object_key(prefix, filename)
        # 同名拒传：登记阶段就拒掉，避免后续 upload-cloud 冲突
        if object_exists(get_client(), os.environ["B2_BUCKET"], object_key):
            return respond("error", f"同名文件已存在：{object_key}", apikey, "error", 400)

    filename = PurePosixPath(urlparse(url).path).name or "download"

    if target == "server":
        # 下载到服务器路径：自动入队处理（保持原逻辑）
        job_id = insert_job(
            kind="fetch",
            filename=filename,
            object_key=object_key,
            size=0,
            source=url,
            destination=str(destination),
        )
        JOB_QUEUE.put(job_id)
        emit_job_update(job_id)
        return respond(
            "ok", f"「{url}」下载到 {destination} 的任务已加入队列。", apikey,
            job_id=job_id, object_key=object_key, filename=filename,
        )

    # 录入到 bucket：只登记一条 pending 记录，不自动下载/上传。
    # 用户在列表点「上传」时才触发（POST /api/upload-file/<file_id>）。
    file_id = insert_file_pending(
        job_id=None,
        object_key=object_key,
        filename=filename,
        size=0,
        source_url=url,
        datasource_id=datasource_id,
    )
    return respond(
        "ok", f"「{filename}」已登记。", apikey,
        file_id=file_id, object_key=object_key, filename=filename,
    )


@app.post("/api/files/<int:file_id>/upload-cloud")
def api_file_upload_cloud(file_id: int):
    """把服务器本地文件上传到 bucket。

    要求 files.local_path 存在（先下载到服务器）且尚未 uploaded=1。
    建 kind=upload job 入队，worker 从本地路径读取并上传到 bucket。
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    with get_db() as conn:
        row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"文件记录 {file_id} 不存在"}), 404
    f = dict(row)

    if f.get("uploaded"):
        return jsonify({"error": "该文件已上传到云"}), 400
    local_path = f.get("local_path")
    if not local_path:
        return jsonify({"error": "本地文件不存在，请先下载到服务器"}), 400

    try:
        source = resolve_local_path(local_path)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not source.exists():
        return jsonify({"error": f"本地文件不存在: {local_path}"}), 400

    body = request.get_json(silent=True) or {}
    custom_key = (body.get("key") or "").strip().lstrip("/")
    object_key = custom_key or f["object_key"]

    filename = f["filename"] or "download"
    job_id = insert_job(
        kind="upload",
        filename=filename,
        object_key=object_key,
        size=f.get("size") or 0,
        source=str(source),
    )
    with get_db() as conn:
        conn.execute(
            "UPDATE files SET job_id=?, object_key=?, updated_at=? WHERE id=?",
            (job_id, object_key, time.time(), file_id),
        )
    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    return jsonify({
        "status": "ok",
        "message": f"「{filename}」上传到云的任务已加入队列。",
        "job_id": job_id,
        "file_id": file_id,
    })


@app.post("/api/files/<int:file_id>/download-server")
def api_file_download_server(file_id: int):
    """下载文件到服务器 SERVER_FILE_ROOT（保留原始文件名）。

    - 已在 bucket（uploaded=1）：从 bucket 下载（kind=download）。
    - 有 source_url 且未上传：从 URL 抓取到服务器（kind=fetch + destination）。
    成功后 worker 回写 files.local_path。
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    with get_db() as conn:
        row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"文件记录 {file_id} 不存在"}), 404
    f = dict(row)

    if f.get("local_path"):
        return jsonify({"error": "该文件已在服务器上"}), 400

    object_key = f["object_key"]
    filename = f["filename"] or "download"

    root = server_root()
    if root is None:
        return jsonify({"error": "未配置 SERVER_FILE_ROOT"}), 400
    root.mkdir(parents=True, exist_ok=True)
    destination = root / filename

    if f.get("uploaded"):
        # bucket → server：校验对象存在并取真实大小
        try:
            metadata = get_client().head_object(Bucket=os.environ["B2_BUCKET"], Key=object_key)
            size = int(metadata["ContentLength"])
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in ("404", "NoSuchKey", "NotFound"):
                return jsonify({"error": f"bucket 中不存在对象: {object_key}"}), 404
            return jsonify({"error": str(exc)}), 502
        except (BotoCoreError, OSError) as exc:
            return jsonify({"error": str(exc)}), 502

        job_id = insert_job(
            kind="download",
            filename=filename,
            object_key=object_key,
            size=size,
            destination=str(destination),
        )
    elif f.get("source_url"):
        # URL → server
        job_id = insert_job(
            kind="fetch",
            filename=filename,
            object_key=object_key,
            size=0,
            source=f["source_url"],
            destination=str(destination),
        )
    else:
        return jsonify({"error": "无可下载来源（既不在 bucket 也无来源链接）"}), 400

    with get_db() as conn:
        conn.execute("UPDATE files SET job_id=? WHERE id=?", (job_id, file_id))
    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    return jsonify({
        "status": "ok",
        "message": f"「{filename}」下载到服务器 {destination} 的任务已加入队列。",
        "job_id": job_id,
        "file_id": file_id,
    })


@app.post("/api/files/<int:file_id>/upload-beijing")
def api_file_upload_beijing(file_id: int):
    """把服务器本地文件上传到北京桶（与 upload-cloud 对称）。

    要求 beijing_enabled()、files.local_path 存在且尚未 uploaded_beijing=1。
    建 kind=upload_beijing job 入队，worker 上传到北京桶并写 uploaded_beijing=1。
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    if not beijing_enabled():
        return jsonify({"error": "北京桶未启用"}), 400

    with get_db() as conn:
        row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"文件记录 {file_id} 不存在"}), 404
    f = dict(row)

    if f.get("uploaded_beijing"):
        return jsonify({"error": "该文件已上传到北京桶"}), 400
    local_path = f.get("local_path")
    if not local_path:
        return jsonify({"error": "本地文件不存在，请先下载到服务器"}), 400

    try:
        source = resolve_local_path(local_path)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if not source.exists():
        return jsonify({"error": f"本地文件不存在: {local_path}"}), 400

    body = request.get_json(silent=True) or {}
    custom_key = (body.get("key") or "").strip().lstrip("/")
    object_key = custom_key or f["object_key"]

    filename = f["filename"] or "download"
    job_id = insert_job(
        kind="upload_beijing",
        filename=filename,
        object_key=object_key,
        size=f.get("size") or 0,
        source=str(source),
    )
    with get_db() as conn:
        conn.execute(
            "UPDATE files SET job_id=?, object_key=?, updated_at=? WHERE id=?",
            (job_id, object_key, time.time(), file_id),
        )
    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    return jsonify({
        "status": "ok",
        "message": f"「{filename}」上传到北京桶的任务已加入队列。",
        "job_id": job_id,
        "file_id": file_id,
    })


@app.post("/api/files/<int:file_id>/download-server-beijing")
def api_file_download_server_beijing(file_id: int):
    """从北京桶下载文件到服务器（与 download-server 的 bucket→server 分支对称）。

    要求 beijing_enabled()、uploaded_beijing=1、且尚未下载到服务器。
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    if not beijing_enabled():
        return jsonify({"error": "北京桶未启用"}), 400

    with get_db() as conn:
        row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"文件记录 {file_id} 不存在"}), 404
    f = dict(row)

    if f.get("local_path"):
        return jsonify({"error": "该文件已在服务器上"}), 400
    if not f.get("uploaded_beijing"):
        return jsonify({"error": "该文件未上传到北京桶"}), 400

    object_key = f["object_key"]
    filename = f["filename"] or "download"

    root = server_root()
    if root is None:
        return jsonify({"error": "未配置 SERVER_FILE_ROOT"}), 400
    root.mkdir(parents=True, exist_ok=True)
    destination = root / filename

    client, bucket = resolve_bucket("beijing")
    try:
        metadata = client.head_object(Bucket=bucket, Key=object_key)
        size = int(metadata["ContentLength"])
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            return jsonify({"error": f"北京桶中不存在对象: {object_key}"}), 404
        return jsonify({"error": str(exc)}), 502
    except (BotoCoreError, OSError) as exc:
        return jsonify({"error": str(exc)}), 502

    job_id = insert_job(
        kind="download_beijing",
        filename=filename,
        object_key=object_key,
        size=size,
        destination=str(destination),
    )
    with get_db() as conn:
        conn.execute("UPDATE files SET job_id=? WHERE id=?", (job_id, file_id))
    JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    return jsonify({
        "status": "ok",
        "message": f"「{filename}」从北京桶下载到服务器 {destination} 的任务已加入队列。",
        "job_id": job_id,
        "file_id": file_id,
    })


@app.post("/api/files/<int:file_id>/check")
def api_file_check(file_id: int):
    """重新检测文件在指定位置是否存在，按结果更新记录。

    请求体 JSON：
        {"target": "local" | "cloud" | "beijing"}

    始终做真实检测（不因 DB 标记为空就跳过）：
    - local：local_path 为空时回退到 SERVER_FILE_ROOT/filename
    - cloud/beijing：直接查桶，不因 uploaded=0 就返回 False

    返回：
        {"target": "...", "exists": true/false, "file": {更新后的记录}}
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    body = request.get_json(silent=True) or {}
    target = (body.get("target") or "local").strip()

    with get_db() as conn:
        row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"文件记录 {file_id} 不存在"}), 404
    f = dict(row)
    now = time.time()

    if target == "local":
        root = server_root()
        if root is None:
            return jsonify({"error": "未配置 SERVER_FILE_ROOT"}), 400

        local_path = f.get("local_path")
        # local_path 有值 → 检它；无值 → 回退到 root/filename
        if local_path:
            try:
                path = resolve_local_path(local_path)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
        else:
            filename = f.get("filename") or ""
            if not filename:
                return jsonify({"target": "local", "exists": False, "file": f})
            path = (root / filename).resolve()

        exists = path.is_file()
        file_size = path.stat().st_size if exists else 0
        with get_db() as conn:
            if exists:
                # 文件在磁盘上 → 补记 local_path（若空）+ 更新 size
                sets = ["size=?", "updated_at=?"]
                params = [file_size, now]
                if not local_path:
                    try:
                        rel = path.relative_to(root.resolve()).as_posix()
                    except ValueError:
                        rel = path.name
                    sets.append("local_path=?")
                    params.append(rel)
                params.append(file_id)
                conn.execute(
                    f"UPDATE files SET {', '.join(sets)} WHERE id=?", params,
                )
            elif local_path:
                # DB 有记录但文件已不在 → 清空 local_path
                conn.execute(
                    "UPDATE files SET local_path=NULL, updated_at=? WHERE id=?",
                    (now, file_id),
                )
            row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
        f = dict(row)
        return jsonify({"target": "local", "exists": exists, "file": f})

    if target == "cloud":
        try:
            resp = get_client().head_object(
                Bucket=os.environ["B2_BUCKET"], Key=f["object_key"]
            )
            exists = True
            file_size = resp.get("ContentLength") or 0
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in ("404", "NoSuchKey", "NotFound"):
                exists = False
                file_size = 0
            else:
                return jsonify({"error": str(exc)}), 502
        except (BotoCoreError, OSError) as exc:
            return jsonify({"error": str(exc)}), 502
        with get_db() as conn:
            if exists:
                sets = ["size=?", "updated_at=?"]
                params = [file_size, now]
                if not f.get("uploaded"):
                    sets.extend(["uploaded=1", "status='synced'", "synced_at=?"])
                    params.append(now)
                params.append(file_id)
                conn.execute(
                    f"UPDATE files SET {', '.join(sets)} WHERE id=?", params,
                )
            elif f.get("uploaded"):
                conn.execute(
                    "UPDATE files SET uploaded=0, status='pending', updated_at=? WHERE id=?",
                    (now, file_id),
                )
            row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
        f = dict(row)
        return jsonify({"target": "cloud", "exists": exists, "file": f})

    if target == "beijing":
        if not beijing_enabled():
            return jsonify({"error": "北京桶未启用"}), 400
        try:
            resp = get_beijing_client().head_object(
                Bucket=os.environ["BEIJING_BUCKET"], Key=f["object_key"]
            )
            exists = True
            file_size = resp.get("ContentLength") or 0
        except ClientError as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            if code in ("404", "NoSuchKey", "NotFound"):
                exists = False
                file_size = 0
            else:
                return jsonify({"error": str(exc)}), 502
        except (BotoCoreError, OSError) as exc:
            return jsonify({"error": str(exc)}), 502
        with get_db() as conn:
            if exists:
                sets = ["size=?", "updated_at=?"]
                params = [file_size, now]
                if not f.get("uploaded_beijing"):
                    sets.append("uploaded_beijing=1")
                params.append(file_id)
                conn.execute(
                    f"UPDATE files SET {', '.join(sets)} WHERE id=?", params,
                )
            elif f.get("uploaded_beijing"):
                conn.execute(
                    "UPDATE files SET uploaded_beijing=0, updated_at=? WHERE id=?",
                    (now, file_id),
                )
            row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
        f = dict(row)
        return jsonify({"target": "beijing", "exists": exists, "file": f})

    return jsonify({"error": f"无效的 target: {target}（可选 local / cloud / beijing）"}), 400


@app.get("/download")
def download():
    blocked = require_auth()
    if blocked:
        return blocked
    key = (request.args.get("key") or "").lstrip("/")
    if not key:
        return jsonify({"error": "缺少 key 参数"}), 400

    bucket_target = (request.args.get("bucket") or "self").strip()
    if bucket_target == "beijing":
        if not beijing_enabled():
            return jsonify({"error": "北京桶未启用"}), 400
        client, bucket = resolve_bucket("beijing")
    else:
        client, bucket = resolve_bucket("self")

    try:
        obj = client.get_object(Bucket=bucket, Key=key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in ("404", "NoSuchKey", "NotFound") or status == 404:
            return jsonify({"error": f"对象不存在: {key}"}), 404
        return jsonify({"error": f"下载失败: {exc}"}), 502
    except (BotoCoreError, OSError) as exc:
        return jsonify({"error": f"下载失败: {exc}"}), 502

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


@app.post("/api/submit")
def api_submit():
    """提交 URL 自动下载并上传到 bucket（支持单个/批量）。

    请求头认证：
        X-API-Key: <key>          或
        Authorization: Bearer <key>

    请求体 JSON：
    {
        "urls": ["https://...", "https://..."],   // 必填，1~50 个链接
        "prefix": "backups/2026"                  // 可选，对象 key 前缀
    }

    返回（200 或 400）：
    {
        "submitted": 2,
        "jobs": [
            {"url": "https://...", "job_id": 5, "object_key": "abc123.zip", "status": "queued"},
            ...
        ],
        "errors": [
            {"url": "https://bad", "error": "无效的 URL"}
        ]
    }
    """
    if not apikey_ok():
        return jsonify({"error": "未授权：缺少或无效的 apikey"}), 401

    body = request.get_json(silent=True) or {}
    raw_urls = body.get("urls")

    # 也兼容单条 url 字段
    if raw_urls is None:
        single = body.get("url")
        raw_urls = [single] if single else []

    if not raw_urls:
        return jsonify({"error": "请提供 urls 字段（至少一个链接）"}), 400

    if not isinstance(raw_urls, list):
        return jsonify({"error": "urls 必须是数组"}), 400

    if len(raw_urls) > 50:
        return jsonify({"error": "单次最多提交 50 个链接"}), 400

    prefix_raw = body.get("prefix") or default_prefix()
    try:
        prefix = clean_prefix(prefix_raw)
    except argparse.ArgumentTypeError as exc:
        return jsonify({"error": f"prefix 无效: {exc}"}), 400

    submitted: list[dict] = []
    errors: list[dict] = []

    for url in raw_urls:
        url = (url or "").strip()
        if not url.startswith(("http://", "https://")):
            errors.append({"url": url, "error": "链接必须以 http:// 或 https:// 开头"})
            continue
        filename = PurePosixPath(urlparse(url).path).name or "download"
        object_key = build_object_key(prefix, filename)
        # 同名拒传：冲突放进 errors，不中断其它链接
        if object_exists(get_client(), os.environ["B2_BUCKET"], object_key):
            errors.append({"url": url, "error": f"同名文件已存在：{object_key}"})
            continue
        job_id = insert_job(
            kind="fetch",
            filename=filename,
            object_key=object_key,
            size=0,
            source=url,
        )
        insert_file_pending(
            job_id=job_id,
            object_key=object_key,
            filename=filename,
            size=0,
            source_url=url,
        )
        JOB_QUEUE.put(job_id)
        emit_job_update(job_id)
        submitted.append({
            "url": url,
            "job_id": job_id,
            "object_key": object_key,
            "filename": filename,
            "status": "queued",
        })

    return jsonify({
        "submitted": len(submitted),
        "jobs": submitted,
        "errors": errors,
    }), (200 if submitted else 400)


@app.get("/api/status/<int:job_id>")
def api_status(job_id: int):
    """查询单个任务及其对应文件的状态。

    返回：
    {
        "job": {
            "id": 5, "status": "done", "kind": "fetch",
            "filename": "photo.jpg", "object_key": "abc123.jpg",
            "source": "https://...", "size": 10240, "progress": 10240,
            "error": null, "created_at": 1234567890
        },
        "file": {
            "id": 3, "status": "synced", "md5": "abc...", "uploaded": 1,
            "bucket": "mybucket", "object_key": "abc123.jpg",
            "synced_at": 1234567895
        } | null
    }
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    with get_db() as conn:
        job = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if job is None:
            return jsonify({"error": f"任务 {job_id} 不存在"}), 404
        file_row = conn.execute("SELECT * FROM files WHERE job_id=?", (job_id,)).fetchone()

    result = {"job": job_payload(dict(job))}
    if file_row is not None:
        f = dict(file_row)
        result["file"] = {
            "id": f["id"],
            "status": f["status"],
            "md5": f["md5"],
            "size": f["size"],
            "uploaded": f["uploaded"],
            "uploaded_beijing": f.get("uploaded_beijing", 0),
            "bucket": f["bucket"],
            "object_key": f["object_key"],
            "synced_at": f["synced_at"],
            "error": f.get("error"),
        }
    else:
        result["file"] = None

    return jsonify(result)


@app.get("/api/jobs")
def api_jobs():
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    return jsonify([job_payload(job) for job in recent_jobs()])


@app.post("/api/jobs/<int:job_id>/cancel")
def api_job_cancel(job_id: int):
    """请求取消一个任务（上传/下载/抓取）。

    仅对 queued/uploading 状态的任务有效；已结束的任务忽略。
    返回当前 job 状态，取消后 worker 会通过 job_update 推送 cancelled。
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"任务 {job_id} 不存在"}), 404
    job = dict(row)
    if job["status"] not in ("queued", "uploading"):
        return jsonify({
            "error": f"任务已处于 {job['status']} 状态，无法取消",
            "job": job_payload(job),
        }), 400

    request_cancel(job_id)

    # 若任务还在队列中尚未被 worker 取出，直接标记取消，避免 worker 取出后白跑
    if job["status"] == "queued":
        with get_db() as conn:
            conn.execute(
                "UPDATE jobs SET status='cancelled', error='任务已取消', finished_at=? WHERE id=?",
                (time.time(), job_id),
            )
        clear_cancel(job_id)
        emit_job_update(job_id)

    with get_db() as conn:
        updated = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return jsonify({"status": "ok", "message": "已请求取消。", "job": job_payload(dict(updated))})


@app.post("/api/jobs/<int:job_id>/pause")
def api_job_pause(job_id: int):
    """请求暂停一个任务（排队中或上传中）。

    暂停后：排队中的任务会被 worker 跳过；上传中的任务在下次回调时阻塞。
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"任务 {job_id} 不存在"}), 404
    job = dict(row)
    if job["status"] not in ("queued", "uploading"):
        return jsonify({
            "error": f"任务已处于 {job['status']} 状态，无法暂停",
            "job": job_payload(job),
        }), 400

    request_pause(job_id)
    with get_db() as conn:
        conn.execute("UPDATE jobs SET paused=1 WHERE id=?", (job_id,))
        updated = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    emit_job_update(job_id)
    return jsonify({"status": "ok", "message": "已暂停", "job": job_payload(dict(updated))})


@app.post("/api/jobs/<int:job_id>/resume")
def api_job_resume(job_id: int):
    """恢复已暂停的任务。

    - 排队中的任务：被 worker 跳过后需要重新入队
    - 上传中的任务：解除回调阻塞，传输继续
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"任务 {job_id} 不存在"}), 404

    request_resume(job_id)
    with get_db() as conn:
        conn.execute("UPDATE jobs SET paused=0 WHERE id=?", (job_id,))
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    job = dict(row)
    if job["status"] == "queued":
        JOB_QUEUE.put(job_id)
    emit_job_update(job_id)
    return jsonify({"status": "ok", "message": "已恢复", "job": job_payload(job)})


@app.get("/api/auth")
def api_auth():
    """鉴权探测：返回应用基本信息（bucket、安全状态、默认前缀）。

    前端 AuthGuard 用它校验 apikey 是否有效（无 key → 401）。
    单独端点而非复用 / ：因为前端 Vite dev server / nginx 的 / 是 SPA 入口，
    不会被代理到后端，无法用于鉴权探测。
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    return jsonify({
        "app": "b2-file-manager",
        "bucket": os.environ["B2_BUCKET"],
        "default_prefix": default_prefix(),
        "bucket_private": BUCKET_PRIVATE,
        "bucket_private_note": BUCKET_PRIVATE_NOTE,
        "beijing_enabled": beijing_enabled(),
        "beijing_bucket": os.environ.get("BEIJING_BUCKET", ""),
    })


@app.get("/api/bucket-health")
def api_bucket_health():
    """检测自己桶 / 北京桶的连通性 + 元数据（head_bucket 等）。"""
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    self_endpoint, _ = resolve_endpoint()
    result = {
        "self": check_bucket_health(
            get_client(), os.environ["B2_BUCKET"], self_endpoint, "auto"
        ),
        "beijing": None,
    }
    if beijing_enabled():
        bj_endpoint, _ = resolve_beijing_endpoint()
        result["beijing"] = check_bucket_health(
            get_beijing_client(),
            os.environ["BEIJING_BUCKET"],
            bj_endpoint,
            "virtual",
        )
    return jsonify(result)


@app.get("/api/files")
def api_files():
    """文件库分页列表（DataTable 数据源）。

    查询参数：
        page      页码，从 1 起（默认 1）
        page_size 每页条数，1~200（默认 20）
        q         可选，按 filename / source_url 模糊匹配
        status    可选，按 status 精确过滤

    返回：
        {
          "items": [ {...file 列...} ],
          "total": 123, "page": 1, "page_size": 20
        }
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    page = max(1, request.args.get("page", 1, type=int))
    page_size = min(200, max(1, request.args.get("page_size", 20, type=int)))
    offset = (page - 1) * page_size
    q = (request.args.get("q") or "").strip()
    status = (request.args.get("status") or "").strip()

    where_sql = ""
    params: list = []
    conditions: list[str] = []
    if q:
        like = f"%{q}%"
        conditions.append(
            "(filename LIKE ? OR source_url LIKE ?)"
        )
        params.extend([like, like])
    if status:
        conditions.append("status = ?")
        params.append(status)
    if conditions:
        where_sql = "WHERE " + " AND ".join(conditions)

    with get_db() as conn:
        total = conn.execute(
            f"SELECT COUNT(*) AS c FROM files {where_sql}", params
        ).fetchone()["c"]
        rows = conn.execute(
            f"SELECT * FROM files {where_sql} ORDER BY id DESC LIMIT ? OFFSET ?",
            [*params, page_size, offset],
        ).fetchall()

    return jsonify({
        "items": [dict(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@app.get("/api/scripts")
def api_scripts():
    """数据源列表（供文件表格「数据源」列做 id→名称映射）。"""
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    return jsonify(recent_scripts())


@app.delete("/api/objects")
def api_delete_object():
    """删除 bucket 中的一个对象。

    请求体 JSON：
        {"key": "path/to/object.zip"}

    返回：
        {"deleted": true, "key": "path/to/object.zip"}
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    body = request.get_json(silent=True) or {}
    key = (body.get("key") or "").strip().lstrip("/")
    if not key:
        return jsonify({"error": "缺少 key 参数"}), 400

    try:
        get_client().delete_object(Bucket=os.environ["B2_BUCKET"], Key=key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            return jsonify({"error": f"对象不存在: {key}"}), 404
        return jsonify({"error": str(exc)}), 502
    except (BotoCoreError, OSError) as exc:
        return jsonify({"error": str(exc)}), 502

    # 同步更新本地 files 表
    with get_db() as conn:
        conn.execute(
            "UPDATE files SET status='deleted', uploaded=0, updated_at=? WHERE object_key=?",
            (time.time(), key),
        )

    return jsonify({"deleted": True, "key": key})


@app.post("/api/objects/rename")
def api_rename_object():
    """重命名/移动桶内对象（copy + delete）。

    请求体 JSON：
        {"bucket": "self|beijing", "from_key": "old/path", "to_key": "new/path"}

    返回：
        {"ok": true, "from_key": "...", "to_key": "..."}
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    body = request.get_json(silent=True) or {}
    target = (body.get("bucket") or "self").strip()
    from_key = (body.get("from_key") or "").strip().lstrip("/")
    to_key = (body.get("to_key") or "").strip().lstrip("/")

    if not from_key or not to_key:
        return jsonify({"error": "缺少 from_key 或 to_key"}), 400
    if from_key == to_key:
        return jsonify({"error": "新名称与原名称相同"}), 400

    try:
        client, bucket_name = resolve_bucket(target)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    source = {"Bucket": bucket_name, "Key": from_key}
    try:
        client.copy_object(Bucket=bucket_name, Key=to_key, CopySource=source)
        client.delete_object(Bucket=bucket_name, Key=from_key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            return jsonify({"error": f"源对象不存在: {from_key}"}), 404
        return jsonify({"error": str(exc)}), 502
    except (BotoCoreError, OSError) as exc:
        return jsonify({"error": str(exc)}), 502

    # 同步更新 files 表的 object_key
    with get_db() as conn:
        conn.execute(
            "UPDATE files SET object_key=?, updated_at=? WHERE object_key=?",
            (to_key, time.time(), from_key),
        )

    return jsonify({"ok": True, "from_key": from_key, "to_key": to_key})


@app.delete("/api/files/<int:file_id>")
def api_delete_file(file_id: int):
    """删除文件记录（仅删除数据库记录，不删除任何桶中的文件对象）。"""
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    with get_db() as conn:
        row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
    if row is None:
        return jsonify({"error": f"文件记录 {file_id} 不存在"}), 404

    with get_db() as conn:
        conn.execute("DELETE FROM files WHERE id=?", (file_id,))

    return jsonify({"deleted": True, "file_id": file_id})


@app.patch("/api/files/<int:file_id>")
def api_update_file(file_id: int):
    """手动编辑文件记录（所有字段均可选，仅更新提供的字段）。

    请求体 JSON（均可选）：
        filename, object_key, bucket   字符串（object_key/bucket 空串也写入）
        md5, source_url, local_path, error  可空字符串（null/空→NULL）
        size                           整数
        uploaded, uploaded_beijing     true/false → 1/0
        status                         pending|synced|failed|deleted|cancelled
        datasource_id                  整数或 null

    返回：
        {"status": "ok", "file_id": id, "file": {更新后的行}}
    """
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401

    body = request.get_json(silent=True) or {}
    fields: list[str] = []
    params: list = []

    # 可空字符串字段：null/空字符串 → NULL
    for key in ("filename", "md5", "source_url", "local_path", "error"):
        if key in body:
            val = body[key]
            if val:
                fields.append(f"{key} = ?")
                params.append(str(val))
            else:
                fields.append(f"{key} = NULL")

    # 非空字符串字段（空串也写入）
    for key in ("object_key", "bucket"):
        if key in body:
            fields.append(f"{key} = ?")
            params.append(str(body[key]))

    # 整数字段
    if "size" in body:
        fields.append("size = ?")
        params.append(int(body["size"] or 0))

    # 布尔→0/1 字段
    for key in ("uploaded", "uploaded_beijing"):
        if key in body:
            fields.append(f"{key} = ?")
            params.append(1 if body[key] else 0)

    # status 枚举校验
    if "status" in body:
        status_val = str(body["status"])
        if status_val in ("pending", "synced", "failed", "deleted", "cancelled"):
            fields.append("status = ?")
            params.append(status_val)

    # datasource_id 可空整数
    if "datasource_id" in body:
        val = body["datasource_id"]
        if val:
            fields.append("datasource_id = ?")
            params.append(int(val))
        else:
            fields.append("datasource_id = NULL")

    if not fields:
        return jsonify({"error": "没有可更新的字段"}), 400

    fields.append("updated_at = ?")
    params.append(time.time())
    params.append(file_id)

    with get_db() as conn:
        row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
        if row is None:
            return jsonify({"error": f"文件记录 {file_id} 不存在"}), 404
        conn.execute(
            f"UPDATE files SET {', '.join(fields)} WHERE id = ?", params
        )
        conn.commit()
        row = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()

    return jsonify({"status": "ok", "file_id": file_id, "file": dict(row)})


@app.get("/api/objects")
def api_objects():
    if not apikey_ok():
        return jsonify({"error": "未授权"}), 401
    target = request.args.get("bucket", "self").strip() or "self"
    raw_prefix = request.args.get("prefix", "") or default_prefix()
    q = (request.args.get("q") or "").strip()
    page = max(1, request.args.get("page", 1, type=int))
    page_size = max(1, min(200, request.args.get("page_size", 50, type=int)))
    try:
        prefix = clean_prefix(raw_prefix)
    except argparse.ArgumentTypeError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        client, bucket_name = resolve_bucket(target)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        all_objects = list_objects(prefix, limit=None, client=client, bucket_name=bucket_name)
    except (BotoCoreError, ClientError) as exc:
        return jsonify({"error": str(exc)}), 502
    if q:
        ql = q.lower()
        all_objects = [o for o in all_objects if ql in o["key"].lower()]
    total = len(all_objects)
    start = (page - 1) * page_size
    objects = all_objects[start:start + page_size]
    return jsonify({
        "prefix": prefix,
        "bucket": target,
        "objects": objects,
        "total": total,
        "page": page,
        "page_size": page_size,
    })


@app.post("/scripts")
def add_script():
    """新增数据源（名称必填，脚本路径允许为空）。"""
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")
    name = (request.form.get("name") or "").strip()
    script_path = (request.form.get("script_path") or "").strip()
    description = (request.form.get("description") or "").strip()
    if not name:
        return respond("error", "数据源名称必填。", apikey, "error", 400)
    now = time.time()
    with get_db() as conn:
        conn.execute(
            "INSERT INTO datasources (name, script_path, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (name, script_path or None, description or None, now, now),
        )
    return respond("ok", f"数据源「{name}」已添加。", apikey)


@app.post("/scripts/delete")
def delete_script():
    """删除数据源，同时解除 files 的关联。"""
    blocked = require_auth()
    if blocked:
        return blocked
    apikey = request.args.get("apikey", "")
    datasource_id = request.form.get("id", type=int)
    if datasource_id:
        with get_db() as conn:
            conn.execute("DELETE FROM datasources WHERE id=?", (datasource_id,))
            conn.execute("UPDATE files SET datasource_id=NULL WHERE datasource_id=?", (datasource_id,))
        return respond("ok", "数据源已删除。", apikey)
    return respond("error", "缺少数据源 id。", apikey, "error", 400)


def main() -> int:
    parser = argparse.ArgumentParser(description="启动文件同步助手（开发模式）")
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
    print(f"文件同步助手已启动: http://{host}:{port}/?apikey=<APP_API_KEY>")
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
    if beijing_enabled():
        cleanup_stale_multipart(client=get_beijing_client(), bucket_name=os.environ["BEIJING_BUCKET"])
    for i in range(max(1, MAX_WORKERS)):
        threading.Thread(target=worker_loop, name=f"worker-{i}", daemon=True).start()

    global BUCKET_PRIVATE, BUCKET_PRIVATE_NOTE
    BUCKET_PRIVATE, BUCKET_PRIVATE_NOTE = check_bucket_private()
    if BUCKET_PRIVATE is False:
        print(f"⚠️ 安全警告: {BUCKET_PRIVATE_NOTE}", file=sys.stderr)
    else:
        print(f"安全检测: {BUCKET_PRIVATE_NOTE}")


if __name__ == "__main__":
    raise SystemExit(main())
