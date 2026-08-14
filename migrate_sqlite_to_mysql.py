#!/usr/bin/env python3
"""一次性迁移脚本：把 jobs.db 数据导入 MySQL。

前置条件：
  1. .env 已填写 MySQL 连接信息
  2. jobs.db 存在
  3. MySQL 表已通过 init_db() 建好

用法：python migrate_sqlite_to_mysql.py
"""
import sqlite3
import sys
from pathlib import Path

from db import get_db

BASE_DIR = Path(__file__).resolve().parent
SQLITE_PATH = BASE_DIR / "jobs.db"

TABLES = ["datasources", "jobs", "files"]


def migrate():
    if not SQLITE_PATH.exists():
        print(f"错误: {SQLITE_PATH} 不存在", file=sys.stderr)
        return 1

    src = sqlite3.connect(SQLITE_PATH)
    src.row_factory = sqlite3.Row

    with get_db() as dst:
        for table in TABLES:
            exists = src.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            ).fetchone()
            if not exists:
                print(f"跳过: SQLite 中无 {table} 表")
                continue

            cols = [r["name"] for r in src.execute(f"PRAGMA table_info({table})")]
            col_list = ", ".join(cols)
            placeholders = ", ".join(["?"] * len(cols))
            rows = src.execute(f"SELECT {col_list} FROM {table}").fetchall()

            for row in rows:
                dst.execute(
                    f"INSERT IGNORE INTO {table} ({col_list}) VALUES ({placeholders})",
                    tuple(row),
                )
            print(f"完成: {table} → {len(rows)} 行")

    src.close()
    print("\n迁移完成。请验证数据后删除 jobs.db。")
    return 0


if __name__ == "__main__":
    raise SystemExit(migrate())
