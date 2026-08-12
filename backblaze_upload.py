#!/usr/bin/env python3
"""Upload one file or a directory tree to Backblaze B2 via its S3 API."""

from __future__ import annotations

import argparse
from collections import deque
import mimetypes
import os
import sys
import threading
import time
from pathlib import Path, PurePosixPath


def clean_prefix(value: str) -> str:
    """Normalize an object-key prefix without allowing absolute or parent paths."""
    value = value.replace("\\", "/").strip("/")
    if not value:
        return ""
    parts = PurePosixPath(value).parts
    if ".." in parts:
        raise argparse.ArgumentTypeError("--prefix 不能包含 '..'")
    return "/".join(part for part in parts if part not in ("", "."))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="上传单个文件或整个目录到 Backblaze B2（S3 兼容接口）。"
    )
    parser.add_argument("source", type=Path, help="本地文件或目录路径")
    parser.add_argument("--bucket", required=True, help="目标 Bucket 名称")
    parser.add_argument(
        "--prefix",
        type=clean_prefix,
        default="",
        help="对象名前缀，例如 backups/2026（默认：Bucket 根目录）",
    )
    parser.add_argument(
        "--endpoint",
        default=os.getenv("B2_ENDPOINT"),
        help="S3 Endpoint；也可使用 B2_ENDPOINT 环境变量",
    )
    parser.add_argument(
        "--region",
        default=os.getenv("B2_REGION"),
        help="区域，如 us-west-004；省略时从 endpoint 自动提取",
    )
    parser.add_argument(
        "--key-id",
        default=os.getenv("B2_APPLICATION_KEY_ID"),
        help="Application Key ID；推荐使用 B2_APPLICATION_KEY_ID 环境变量",
    )
    parser.add_argument(
        "--application-key",
        default=os.getenv("B2_APPLICATION_KEY"),
        help="Application Key；推荐使用 B2_APPLICATION_KEY 环境变量",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=4,
        help="单个大文件分片上传的并发数（默认：4）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只显示将上传的文件，不实际上传",
    )
    parser.add_argument(
        "--no-progress",
        action="store_true",
        help="不显示逐文件上传进度",
    )
    return parser.parse_args()


def normalize_endpoint(endpoint: str | None, region: str | None) -> tuple[str, str]:
    if not endpoint:
        if not region:
            raise ValueError("必须提供 --endpoint（或 B2_ENDPOINT），或者提供 --region")
        endpoint = f"https://s3.{region}.backblazeb2.com"
    elif not endpoint.startswith(("https://", "http://")):
        endpoint = "https://" + endpoint

    endpoint = endpoint.rstrip("/")
    host = endpoint.split("://", 1)[-1].split("/", 1)[0]
    if not region:
        labels = host.split(".")
        if len(labels) >= 4 and labels[0] == "s3":
            region = labels[1]
    if not region:
        raise ValueError("无法从 endpoint 识别 region，请显式提供 --region")
    return endpoint, region


def iter_uploads(source: Path, prefix: str):
    source = source.expanduser().resolve()
    if source.is_file():
        key = "/".join(part for part in (prefix, source.name) if part)
        yield source, key
        return
    if not source.is_dir():
        raise FileNotFoundError(f"本地路径不存在或不是普通文件/目录: {source}")

    # 上传目录内容，不额外把目录本身的名称加入对象 key。
    for path in sorted(source.rglob("*")):
        if path.is_file() and not path.is_symlink():
            relative = path.relative_to(source).as_posix()
            key = "/".join(part for part in (prefix, relative) if part)
            yield path, key


def format_bytes(value: float) -> str:
    units = ("B", "KiB", "MiB", "GiB", "TiB")
    for unit in units:
        if value < 1024 or unit == units[-1]:
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.2f} {unit}"
        value /= 1024
    return f"{value:.2f} TiB"


def format_duration(seconds: float | None) -> str:
    if seconds is None or seconds < 0:
        return "--:--"
    seconds = int(seconds + 0.5)
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:d}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"


class Progress:
    def __init__(self, filename: str, total: int) -> None:
        self.filename = filename
        self.total = total
        self.seen = 0
        self.lock = threading.Lock()
        self.started = time.monotonic()
        self.last_printed = 0.0
        self.last_width = 0
        self.samples = deque([(self.started, 0)])

    def __call__(self, amount: int) -> None:
        with self.lock:
            self.seen = max(0, min(self.total, self.seen + amount))
            now = time.monotonic()
            self.samples.append((now, self.seen))

            # 使用最近约 10 秒的滑动窗口计算速度，同时保留窗口边界前一个样本。
            cutoff = now - 10.0
            while len(self.samples) > 2 and self.samples[1][0] <= cutoff:
                self.samples.popleft()

            # 限制终端刷新频率，避免高带宽上传时打印本身成为瓶颈。
            if self.seen < self.total and now - self.last_printed < 0.2:
                return
            self._render(now)

    def _render(self, now: float) -> None:
        sample_time, sample_bytes = self.samples[0]
        interval = now - sample_time
        speed = (self.seen - sample_bytes) / interval if interval > 0.05 else 0.0
        remaining = max(0, self.total - self.seen)
        eta = remaining / speed if speed > 0 else None
        percent = 100.0 if self.total == 0 else min(100.0, self.seen * 100 / self.total)
        speed_text = f"{format_bytes(speed)}/s" if speed > 0 else "--/s"
        line = (
            f"  {self.filename}: {percent:6.2f}%  "
            f"{format_bytes(self.seen)}/{format_bytes(self.total)}  "
            f"{speed_text}  ETA {format_duration(eta)}"
        )
        print(f"\r{line.ljust(self.last_width)}", end="", flush=True)
        self.last_width = max(self.last_width, len(line))
        self.last_printed = now

    def finish(self) -> None:
        with self.lock:
            self.seen = self.total
            now = time.monotonic()
            self.samples.append((now, self.seen))
            self._render(now)
            print()


def main() -> int:
    args = parse_args()
    if args.workers < 1:
        print("错误: --workers 必须大于等于 1", file=sys.stderr)
        return 2

    try:
        endpoint, region = normalize_endpoint(args.endpoint, args.region)
        uploads = list(iter_uploads(args.source, args.prefix))
    except (ValueError, OSError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2

    if not uploads:
        print("没有找到可上传的文件。")
        return 0

    print(f"目标: b2://{args.bucket}/{args.prefix}".rstrip("/"))
    print(f"Endpoint: {endpoint}  Region: {region}")
    print(f"文件数: {len(uploads)}")

    if args.dry_run:
        for local_path, object_key in uploads:
            print(f"[预览] {local_path} -> b2://{args.bucket}/{object_key}")
        return 0

    if not args.key_id or not args.application_key:
        print(
            "错误: 缺少凭证。请设置 B2_APPLICATION_KEY_ID 和 "
            "B2_APPLICATION_KEY，或传入对应命令行参数。",
            file=sys.stderr,
        )
        return 2

    try:
        import boto3
        from boto3.s3.transfer import TransferConfig
        from botocore.config import Config
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError:
        print(
            "缺少依赖 boto3，请先运行: python3 -m pip install 'boto3>=1.28.0'",
            file=sys.stderr,
        )
        return 2

    client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=args.key_id,
        aws_secret_access_key=args.application_key,
        config=Config(signature_version="s3v4", retries={"max_attempts": 8, "mode": "standard"}),
    )
    transfer_config = TransferConfig(
        multipart_threshold=100 * 1024 * 1024,
        multipart_chunksize=100 * 1024 * 1024,
        max_concurrency=args.workers,
        use_threads=True,
    )

    uploaded_bytes = 0
    try:
        for index, (local_path, object_key) in enumerate(uploads, 1):
            size = local_path.stat().st_size
            content_type, encoding = mimetypes.guess_type(local_path.name)
            extra_args = {}
            if content_type:
                extra_args["ContentType"] = content_type
            if encoding:
                extra_args["ContentEncoding"] = encoding

            print(f"[{index}/{len(uploads)}] {local_path} -> {object_key}")
            progress = None if args.no_progress else Progress(local_path.name, size)
            client.upload_file(
                str(local_path),
                args.bucket,
                object_key,
                ExtraArgs=extra_args or None,
                Callback=progress,
                Config=transfer_config,
            )
            if progress:
                progress.finish()
            uploaded_bytes += size
    except (BotoCoreError, ClientError, OSError) as exc:
        print(f"\n上传失败: {exc}", file=sys.stderr)
        return 1

    print(f"上传完成：{len(uploads)} 个文件，共 {uploaded_bytes / (1024 * 1024):.2f} MiB。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
