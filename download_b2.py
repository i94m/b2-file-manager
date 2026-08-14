#!/usr/bin/env python3
"""从 Backblaze B2 (S3兼容) 下载指定文件到本地目录"""
import sys
import os
import time
import boto3
from botocore.config import Config

BUCKET = 'iokkkoi'
DEST_DIR = '/Users/wade/web/app/b2-file-manager/server_files'
ENDPOINT = 'https://s3.us-east-005.backblazeb2.com'

FILES = [
    'data/x1-source/fable_delivery_20260802_e1tbFh.zip',
    'data/x1-source/fable_delivery_20260803_PrHIpQ.zip',
    'data/x1-source/fable_delivery_20260804_YRQcLz.zip',
]

class ProgressTracker:
    def __init__(self, filename, total_size):
        self.filename = filename
        self.total = total_size
        self.downloaded = 0
        self.last_print = 0
        self.start_time = time.time()

    def __call__(self, bytes_amount):
        self.downloaded += bytes_amount
        now = time.time()
        if now - self.last_print >= 5:  # 每5秒打印一次进度
            self.last_print = now
            pct = self.downloaded / self.total * 100
            speed = self.downloaded / (now - self.start_time) / (1024**2)
            print(f"  {self.filename}: {pct:.1f}% ({self.downloaded//(1024**2)}/{self.total//(1024**2)} MB, {speed:.1f} MB/s)", flush=True)

def main():
    s3 = boto3.client(
        's3',
        endpoint_url=ENDPOINT,
        region_name='us-east-1',
        aws_access_key_id='005bca69f3828e70000000009',
        aws_secret_access_key='K005y9JmWWeUFLcMGDnrZ10ilSwyDkA',
        config=Config(max_pool_connections=10, retries={'max_attempts': 10}),
    )

    transfer_config = boto3.s3.transfer.TransferConfig(
        max_concurrency=8,
        multipart_threshold=64 * 1024 * 1024,  # 64MB以上用分段
        multipart_chunksize=64 * 1024 * 1024,
    )

    os.makedirs(DEST_DIR, exist_ok=True)

    success = []
    failed = []

    for key in FILES:
        filename = os.path.basename(key)
        dest = os.path.join(DEST_DIR, filename)

        # 检查本地是否已有完整文件
        try:
            head = s3.head_object(Bucket=BUCKET, Key=key)
            remote_size = head['ContentLength']
        except Exception as e:
            print(f"[ERROR] 无法获取 {key} 信息: {e}", flush=True)
            failed.append(filename)
            continue

        if os.path.exists(dest) and os.path.getsize(dest) == remote_size:
            print(f"[SKIP] {filename} 已存在且大小匹配 ({remote_size//(1024**2)} MB)", flush=True)
            success.append(filename)
            continue

        print(f"\n{'='*60}", flush=True)
        print(f"[START] {filename} ({remote_size/(1024**3):.2f} GB)", flush=True)
        print(f"  -> {dest}", flush=True)

        tracker = ProgressTracker(filename, remote_size)
        try:
            s3.download_file(BUCKET, key, dest, Config=transfer_config, Callback=tracker)
            elapsed = time.time() - tracker.start_time
            avg_speed = remote_size / elapsed / (1024**2) if elapsed > 0 else 0
            print(f"[DONE] {filename} 完成! 用时 {elapsed:.0f}s, 平均 {avg_speed:.1f} MB/s", flush=True)
            success.append(filename)
        except Exception as e:
            print(f"[FAIL] {filename} 下载失败: {e}", flush=True)
            failed.append(filename)

    print(f"\n{'='*60}", flush=True)
    print(f"完成统计: 成功 {len(success)}/{len(FILES)}", flush=True)
    if failed:
        print(f"失败文件: {', '.join(failed)}", flush=True)
        sys.exit(1)
    print("全部下载成功!", flush=True)

if __name__ == '__main__':
    main()
