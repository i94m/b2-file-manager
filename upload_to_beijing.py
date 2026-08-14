#!/usr/bin/env python3
"""将 server_files 目录中的文件上传到北京桶（火山引擎 TOS S3 兼容接口）。"""

from __future__ import annotations

import os
import sys
import time
import mimetypes
import threading
from collections import deque
from pathlib import Path

# ── 加载 .env ──
PROJECT_DIR = Path(__file__).resolve().parent
for line in (PROJECT_DIR / ".env").read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, _, value = line.partition("=")
    os.environ.setdefault(key.strip(), value.strip())

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config

BUCKET = os.environ["BEIJING_BUCKET"]
ENDPOINT = "https://" + os.environ["BEIJING_ENDPOINT"].lstrip("https://").lstrip("http://")
REGION = os.environ["BEIJING_REGION"]
KEY_ID = os.environ["BEIJING_APPLICATION_KEY_ID"]
APP_KEY = os.environ["BEIJING_APPLICATION_KEY"]

SERVER_FILES = PROJECT_DIR / "server_files"
LOG_FILE = PROJECT_DIR / "upload_beijing.log"

# 上传对象 key 的前缀（留空 = 桶根目录）
UPLOAD_PREFIX = ""

# ── 分片配置 ──
CHUNK_SIZE = 256 * 1024 * 1024  # 256 MiB
TRANSFER_CONFIG = TransferConfig(
    multipart_threshold=128 * 1024 * 1024,
    multipart_chunksize=CHUNK_SIZE,
    max_concurrency=8,
    use_threads=True,
)

client = boto3.client(
    "s3",
    endpoint_url=ENDPOINT,
    region_name=REGION,
    aws_access_key_id=KEY_ID,
    aws_secret_access_key=APP_KEY,
    config=Config(
        signature_version="s3v4",
        s3={"addressing_style": "virtual"},
        retries={"max_attempts": 10, "mode": "adaptive"},
    ),
)


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")


def format_bytes(v: float) -> str:
    for u in ("B", "KiB", "MiB", "GiB", "TiB"):
        if v < 1024 or u == "TiB":
            return f"{v:.0f} {u}" if u == "B" else f"{v:.2f} {u}"
        v /= 1024
    return f"{v:.2f} TiB"


def format_eta(seconds: float | None) -> str:
    if seconds is None or seconds < 0:
        return "--:--"
    seconds = int(seconds + 0.5)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


class FileProgress:
    """单文件上传进度追踪器。"""

    def __init__(self, filename: str, total: int):
        self.filename = filename
        self.total = total
        self.seen = 0
        self.lock = threading.Lock()
        self.started = time.monotonic()
        self.last_printed = 0.0
        self.samples = deque([(self.started, 0)], maxlen=100)

    def __call__(self, amount: int):
        with self.lock:
            self.seen = min(self.total, self.seen + amount)
            now = time.monotonic()
            self.samples.append((now, self.seen))
            cutoff = now - 15.0
            while len(self.samples) > 2 and self.samples[1][0] <= cutoff:
                self.samples.popleft()
            if self.seen < self.total and now - self.last_printed < 5.0:
                return
            self._render(now)

    def _render(self, now: float):
        st, sb = self.samples[0]
        interval = now - st
        speed = (self.seen - sb) / interval if interval > 0.1 else 0.0
        remaining = max(0, self.total - self.seen)
        eta = remaining / speed if speed > 0 else None
        pct = 100.0 if self.total == 0 else min(100.0, self.seen * 100 / self.total)
        spd = f"{format_bytes(speed)}/s" if speed > 0 else "--/s"
        log(
            f"  {self.filename}: {pct:5.1f}%  "
            f"{format_bytes(self.seen)}/{format_bytes(self.total)}  "
            f"{spd}  ETA {format_eta(eta)}"
        )
        self.last_printed = now

    def finish(self):
        with self.lock:
            self.seen = self.total
            now = time.monotonic()
            self.samples.append((now, self.seen))
            self._render(now)


def remote_object_size(key: str) -> int | None:
    """返回远端对象大小，不存在则返回 None。"""
    try:
        resp = client.head_object(Bucket=BUCKET, Key=key)
        return resp["ContentLength"]
    except client.exceptions.ClientError:
        return None


def upload_file(local_path: Path, key: str) -> bool:
    """上传单个文件，成功返回 True。"""
    size = local_path.stat().st_size
    content_type, _ = mimetypes.guess_type(local_path.name)
    extra_args = {}
    if content_type:
        extra_args["ContentType"] = content_type

    progress = FileProgress(local_path.name, size)
    log(f"开始上传: {local_path.name} ({format_bytes(size)}) → {BUCKET}/{key}")

    try:
        client.upload_file(
            str(local_path),
            BUCKET,
            key,
            ExtraArgs=extra_args or None,
            Config=TRANSFER_CONFIG,
            Callback=progress,
        )
        progress.finish()
        # 验证
        remote_size = remote_object_size(key)
        if remote_size == size:
            log(f"上传成功: {local_path.name} ✓ ({format_bytes(size)})")
            return True
        else:
            log(f"警告: 大小不匹配！本地={size} 远端={remote_size}")
            return False
    except Exception as exc:
        log(f"上传失败: {local_path.name} — {type(exc).__name__}: {exc}")
        return False


def main() -> int:
    # 收集待上传文件
    local_files = sorted(f for f in SERVER_FILES.iterdir() if f.is_file())
    log("=" * 60)
    log(f"北京桶上传任务启动")
    log(f"Endpoint: {ENDPOINT}")
    log(f"Bucket:   {BUCKET}")
    log(f"Prefix:   '{UPLOAD_PREFIX}'")
    log(f"本地目录: {SERVER_FILES}")
    log(f"文件数:   {len(local_files)}")
    log("=" * 60)

    tasks = []
    for f in local_files:
        key = "/".join(p for p in (UPLOAD_PREFIX, f.name) if p)
        size = f.stat().st_size
        remote = remote_object_size(key)
        if remote == size:
            log(f"跳过（已存在）: {f.name} ({format_bytes(size)})")
            continue
        tasks.append((f, key, size))

    if not tasks:
        log("没有需要上传的文件。")
        return 0

    total_bytes = sum(s for _, _, s in tasks)
    total_gb = total_bytes / (1024**3)
    log(f"待上传: {len(tasks)} 个文件, 共 {total_gb:.1f} GB ({format_bytes(total_bytes)})")
    log("-" * 60)

    overall_start = time.monotonic()
    uploaded_bytes = 0
    success_count = 0
    fail_count = 0

    for i, (f, key, size) in enumerate(tasks, 1):
        log(f"[{i}/{len(tasks)}] 处理 {f.name}")
        ok = upload_file(f, key)
        if ok:
            success_count += 1
            uploaded_bytes += size
        else:
            fail_count += 1

        elapsed = time.monotonic() - overall_start
        done_pct = uploaded_bytes * 100 / total_bytes if total_bytes else 0
        speed = uploaded_bytes / elapsed if elapsed > 0 else 0
        remaining_bytes = total_bytes - uploaded_bytes
        eta = remaining_bytes / speed if speed > 0 else None
        log(
            f"总进度: {done_pct:.1f}%  "
            f"{format_bytes(uploaded_bytes)}/{format_bytes(total_bytes)}  "
            f"{format_bytes(speed)}/s  ETA {format_eta(eta)}"
        )
        log("-" * 60)

    elapsed = time.monotonic() - overall_start
    log("=" * 60)
    log(f"任务完成: 成功 {success_count}, 失败 {fail_count}")
    log(f"总耗时: {format_eta(elapsed)}")
    log(f"总上传: {format_bytes(uploaded_bytes)}")
    log("=" * 60)
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
