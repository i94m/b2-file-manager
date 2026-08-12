#!/usr/bin/env python3
"""Download one object or an object prefix from Backblaze B2 via its S3 API."""

from __future__ import annotations

import argparse
from collections import deque
import os
from pathlib import Path, PurePosixPath
import sys
import tempfile
import threading
import time


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="从 Backblaze B2 下载单个对象或整个前缀目录（S3 兼容接口）。"
    )
    parser.add_argument("remote", help="远端对象名或目录前缀，例如 data/x2-source")
    parser.add_argument("destination", type=Path, help="本地目标文件或目录")
    parser.add_argument("--bucket", required=True, help="源 Bucket 名称")
    parser.add_argument(
        "--endpoint",
        default=os.getenv("B2_ENDPOINT"),
        help="S3 Endpoint；也可使用 B2_ENDPOINT 环境变量",
    )
    parser.add_argument(
        "--region",
        default=os.getenv("B2_REGION"),
        help="区域，如 us-east-005；省略时从 endpoint 自动提取",
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
        help="单个大文件分片下载的并发数（默认：4）",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="覆盖已存在的本地文件（默认：跳过）",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只显示将下载的对象，不实际下载",
    )
    parser.add_argument(
        "--no-progress",
        action="store_true",
        help="不显示逐文件下载进度",
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
            cutoff = now - 10.0
            while len(self.samples) > 2 and self.samples[1][0] <= cutoff:
                self.samples.popleft()
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


def safe_relative_path(key: str, prefix: str) -> Path:
    relative = key[len(prefix):].lstrip("/") if prefix else key.lstrip("/")
    pure = PurePosixPath(relative)
    if not relative or pure.is_absolute() or ".." in pure.parts:
        raise ValueError(f"不安全或无效的对象名: {key!r}")
    return Path(*pure.parts)


def discover_objects(client, bucket: str, remote: str, client_error):
    remote = remote.lstrip("/")
    if remote:
        try:
            metadata = client.head_object(Bucket=bucket, Key=remote)
            return "object", remote, [(remote, int(metadata["ContentLength"]))]
        except client_error as exc:
            code = str(exc.response.get("Error", {}).get("Code", ""))
            status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
            if code not in ("404", "NoSuchKey", "NotFound") and status != 404:
                raise

    prefix = remote.rstrip("/")
    if prefix:
        prefix += "/"
    objects = []
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get("Contents", []):
            key = item["Key"]
            # 以斜杠结尾的零字节对象通常只是目录标记。
            if key.endswith("/") and int(item.get("Size", 0)) == 0:
                continue
            objects.append((key, int(item["Size"])))
    return "prefix", prefix, objects


def local_targets(mode: str, prefix: str, objects, destination: Path):
    destination = destination.expanduser()
    if mode == "object":
        key, size = objects[0]
        target = destination / PurePosixPath(key).name if destination.is_dir() else destination
        return [(key, size, target)]
    return [
        (key, size, destination / safe_relative_path(key, prefix))
        for key, size in objects
    ]


def download_one(client, transfer_config, bucket, key, size, destination, show_progress):
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".part", dir=str(destination.parent)
    )
    os.close(fd)
    completed = False
    try:
        progress = Progress(destination.name, size) if show_progress else None
        client.download_file(
            bucket,
            key,
            temporary_name,
            Callback=progress,
            Config=transfer_config,
        )
        actual_size = os.path.getsize(temporary_name)
        if actual_size != size:
            raise OSError(f"文件大小校验失败：预期 {size}，实际 {actual_size}")
        os.replace(temporary_name, destination)
        completed = True
        if progress:
            progress.finish()
    finally:
        if not completed:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass


def main() -> int:
    args = parse_args()
    if args.workers < 1:
        print("错误: --workers 必须大于等于 1", file=sys.stderr)
        return 2
    try:
        endpoint, region = normalize_endpoint(args.endpoint, args.region)
    except ValueError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2

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

    try:
        mode, prefix, objects = discover_objects(client, args.bucket, args.remote, ClientError)
        if not objects:
            print(f"错误: 没有找到对象或目录前缀: {args.remote}", file=sys.stderr)
            return 1
        targets = local_targets(mode, prefix, objects, args.destination)
    except (BotoCoreError, ClientError, OSError, ValueError) as exc:
        print(f"查询失败: {exc}", file=sys.stderr)
        return 1

    total_bytes = sum(size for _, size, _ in targets)
    print(f"来源: b2://{args.bucket}/{args.remote.lstrip('/')}")
    print(f"Endpoint: {endpoint}  Region: {region}")
    print(f"对象数: {len(targets)}  总大小: {format_bytes(total_bytes)}")

    downloaded = 0
    skipped = 0
    try:
        for index, (key, size, destination) in enumerate(targets, 1):
            print(f"[{index}/{len(targets)}] {key} -> {destination}")
            if destination.exists() and not args.overwrite:
                print("  已存在，跳过（如需覆盖请添加 --overwrite）")
                skipped += 1
                continue
            if destination.exists() and destination.is_dir():
                raise IsADirectoryError(f"目标路径是目录，不能写入文件: {destination}")
            if args.dry_run:
                print("  [预览] 不执行下载")
                continue
            download_one(
                client,
                transfer_config,
                args.bucket,
                key,
                size,
                destination,
                not args.no_progress,
            )
            downloaded += size
    except (BotoCoreError, ClientError, OSError, ValueError) as exc:
        print(f"\n下载失败: {exc}", file=sys.stderr)
        return 1

    if args.dry_run:
        print("预览完成，没有下载任何文件。")
    else:
        print(
            f"下载完成：{len(targets) - skipped} 个文件，"
            f"共 {format_bytes(downloaded)}；跳过 {skipped} 个。"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
