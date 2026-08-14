"""PyMySQL 兼容层：模拟 sqlite3.Connection 接口。

封装 pymysql.connect()，提供与 sqlite3 兼容的 API：
- conn.execute(sql, params) 返回游标（支持 .fetchone() / .fetchall() / .lastrowid）
- 自动将 ? 占位符转换为 %s
- DictCursor 提供字典式行访问
- 上下文管理器：成功时 commit，异常时 rollback，最后 close
"""

from __future__ import annotations

import os

import pymysql
from dotenv import load_dotenv
from pathlib import Path
from pymysql.cursors import DictCursor

load_dotenv(Path(__file__).resolve().parent / ".env")

Error = pymysql.Error


class _ConnectionWrapper:
    """封装 pymysql 连接，模拟 sqlite3.Connection 接口。"""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=None):
        sql = sql.replace("?", "%s")
        cursor = self._conn.cursor()
        cursor.execute(sql, params or ())
        return cursor

    def executemany(self, sql, params_list):
        sql = sql.replace("?", "%s")
        cursor = self._conn.cursor()
        cursor.executemany(sql, params_list)
        return cursor

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        try:
            if exc_type is None:
                self._conn.commit()
            else:
                self._conn.rollback()
        finally:
            self._conn.close()
        return False


def get_db() -> _ConnectionWrapper:
    conn = pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"),
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ.get("DB_USERNAME", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_DATABASE", "model_files"),
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=False,
    )
    return _ConnectionWrapper(conn)
