# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

BucketHub（原 b2-file-manager）：多桶文件传输调度台。后端 Flask（`app.py` 单文件，约 3700 行），前端 React 19 + Vite + TypeScript（`web/`）。通过 S3 兼容接口操作多个对象存储桶（Backblaze B2、火山 TOS 等，桶由数据库驱动、可动态添加）。代码注释、文档、UI 文案均为中文，保持一致。

## 常用命令

```bash
# 后端（开发模式，监听 .env 的 HOST:PORT，默认 127.0.0.1:5000）
uv run python app.py            # 加 --reload 开启热加载

# 后端（生产，gunicorn；必须 --workers 1，原因见下）
.venv/bin/gunicorn --workers 1 --threads 8 --bind 127.0.0.1:8000 wsgi:app

# 前端（Vite dev server 5173，/api、/socket.io 等已反代到 Flask 5000）
cd web && pnpm dev

# 前端构建与 lint（oxlint，无测试套件）
cd web && pnpm build            # tsc -b && vite build
cd web && pnpm lint

# 依赖安装
uv sync                         # Python
cd web && pnpm install          # Node
```

配置在 `.env`（参考 `.env.example`）。桶凭证**不在** .env——完全存于数据库 `buckets` 表，通过页面「桶管理」或 `/api/buckets` 维护。

## 核心架构

### 单进程约束（最重要）

gunicorn 必须保持 `--workers 1`：三条任务队列（上传/下载/串行）、worker 线程池、Socket.IO 广播全部运行在**同一进程内**，多 worker 会导致队列分裂和广播丢失。HTTP 并发靠 `--threads`。`init_runtime()`（建表、恢复中断任务、清理残留分片、启动 worker 线程）在 `app.py` 的 `main()` 和 `wsgi.py` 中都被调用。

### 任务队列（app.py）

- `UPLOAD_QUEUE` / `DOWNLOAD_QUEUE`：两条并行道，各起 `MAX_CONCURRENCY`（默认 8）个常驻 worker 线程，实际并发由 `DynamicGate` 闸门控制——上限可在运行时通过 `/api/concurrency` 调整并持久化到 `settings` 表，调小不影响进行中的任务。
- `SERIAL_QUEUE`：串行道，单 worker，任务严格按提交顺序逐个执行（`serial=true` 提交）。
- 任务流转：`enqueue_job()` 入队 → `worker_loop()` 领任务 → `process_job()` 执行。取消靠 DB 标志位轮询（`request_cancel` 置 `cancelled=1`），暂停靠进程内 `threading.Event`（重启即失效）。
- 进度通过 Socket.IO 事件 `job_update` / `jobs_snapshot` 推送（`emit_job_update`），前端 `use-jobs.tsx` 用滑动窗口样本算实时速率。

### 数据库层（db.py）

`db.py` 是 **PyMySQL 封装的 sqlite3 兼容层**：SQL 里写 `?` 占位符（自动转 `%s`），`DictCursor` 返回字典行，`with get_db() as conn` 成功 commit / 异常 rollback / 最后 close。应用现在用 MySQL；`jobs.db`（SQLite）是历史遗留，`migrate_sqlite_to_mysql.py` 是一次性迁移脚本。

`init_db()` 兼具建表与迁移：`CREATE TABLE IF NOT EXISTS` + 检查 `SHOW COLUMNS` 补齐新增列（加列式迁移），改表结构时在这里追加。

### 桶注册表（app.py）

桶由 `buckets` 表驱动，boto3 client 惰性构建缓存在 `_BUCKET_REGISTRY`（bucket_id → client），凭证/endpoint 变更时 `invalidate_bucket_client()` 失效。所有接口的 `bucket` 参数经 `resolve_bucket_ref()` 统一解析：桶 id（数字，推荐）或 legacy 别名 `self` / `bucket2` / `beijing`（仅存量迁移行带有）。缺省 = 默认桶（第一个添加的）。`LEGACY_FLAG_COLUMNS` 映射的 files 表旧 flag 列仅供镜像写入，勿在业务代码直接 UPDATE。

### 鉴权

所有请求需带 `APP_API_KEY`，三种方式任一：`?apikey=` query、`X-API-Key` header、`Authorization: Bearer`。前端从 URL query 取 key 全程走 header，不缓存 localStorage。

### 前端（web/）

- React 19 + Vite + Tailwind v4 + shadcn/radix（`components.json`，UI 件在 `web/src/components/ui/`），状态靠 Context：`lib/use-jobs.tsx`（Socket.IO 任务实时状态）、`lib/use-buckets.tsx`（桶列表）。
- `lib/api.ts` 是所有后端请求的统一封装（含鉴权 header 与错误处理），新接口调用加在这里，类型定义在 `lib/types.ts`（与后端 JSON 字段一一对应）。
- 生产部署：nginx（见 `nginx.conf`）serve `web/dist/` 并把 `/api`、上传路由、`/socket.io` 反代到 gunicorn 8000；开发期 Vite 自带 proxy 的拓扑与之一致。

### API 文档

`docs/API.md` 是面向机器人/自动化的完整接口文档（提交-轮询-控制工作流、状态机、桶引用规则）。**修改任何 API 行为时同步更新它。**

## 遗留文件（勿混淆）

- 根目录 `package.json`（tailwind 构建 static/）、`static/`、`templates/`：React 迁移前的旧服务端渲染 UI 残留，现前端只看 `web/`。
- `backblaze_upload.py` / `backblaze_download.py`：独立 CLI 工具（argparse，读 `B2_1_*` 环境变量），不被 app 导入（仅 `clean_prefix` / `normalize_endpoint` 除外）。`upload_to_beijing.py` / `download_b2.py` 是一次性脚本。
