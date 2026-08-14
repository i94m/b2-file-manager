# B2 File Manager API 文档

> 供机器人 / 自动化系统 / 第三方集成调用。

## 快速开始

```bash
# 1. 提交一个 URL 下载并上传到 bucket
curl -X POST https://your-host/api/submit \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"urls": ["https://example.com/file.zip"], "prefix": "backups/2026"}'

# 2. 轮询任务状态
curl https://your-host/api/status/5 -H "X-API-Key: YOUR_KEY"

# 3. 暂停 / 恢复 / 取消
curl -X POST https://your-host/api/jobs/5/pause  -H "X-API-Key: YOUR_KEY"
curl -X POST https://your-host/api/jobs/5/resume -H "X-API-Key: YOUR_KEY"
curl -X POST https://your-host/api/jobs/5/cancel -H "X-API-Key: YOUR_KEY"
```

---

## 鉴权

所有接口均需认证。支持三种方式（任选其一）：

| 方式 | 示例 |
|------|------|
| Query 参数 | `?apikey=YOUR_KEY` |
| Header | `X-API-Key: YOUR_KEY` |
| Bearer Token | `Authorization: Bearer YOUR_KEY` |

密钥在 `.env` 的 `APP_API_KEY` 中配置。认证失败统一返回 `401` + JSON `{"error": "未授权"}`。

> 所有接口（含 `/upload`、`/url-upload` 等表单类路由）对机器人默认返回 JSON。
> 无需特殊 `Accept` header — 缺省 `Accept: */*` 或不发 Accept 即返回 JSON。
> 仅浏览器直接提交 HTML 表单（`Accept: text/html`）才会走 redirect。

---

## 核心概念

### Job（任务）

所有上传 / 下载操作都是异步任务。提交后立即返回 `job_id`，后台 worker 并行处理（默认 3 线程，`MAX_WORKERS` 可配）。

**状态流转**：

```
queued → uploading → done
                   → failed
                   → cancelled
```

- `queued`：排队中（等待空闲 worker）
- `uploading`：传输中（含 fetch 下载阶段）
- `done`：完成
- `failed`：失败（`error` 字段含原因）
- `cancelled`：已取消

**暂停状态**：`paused=true` 可叠加在 `queued` 或 `uploading` 上。暂停的排队任务会被 worker 跳过；暂停的传输任务会阻塞在当前进度，恢复后继续。

### File（文件记录）

文件库中的每一条记录，关联上传状态、MD5、本地路径、桶信息等。一个 file 可关联一个 job（当前活跃任务）。

### Kind（任务类型）

| kind | 含义 |
|------|------|
| `fetch` | 从 URL 下载 → 上传到 bucket（或下载到服务器） |
| `upload` | 本地/服务器文件 → 自己桶1 |
| `upload_bucket2` | 本地/服务器文件 → 自己桶2 |
| `upload_beijing` | 本地/服务器文件 → 北京桶 |
| `download` | 自己桶1 → 服务器路径 |
| `download_bucket2` | 自己桶2 → 服务器路径 |
| `download_beijing` | 北京桶 → 服务器路径 |

### Bucket（桶标识）

| 标识 | 环境变量前缀 | 说明 |
|------|-------------|------|
| `self` | `B2_1_*` | 自己桶1（必配） |
| `bucket2` | `B2_2_*` | 自己桶2（可选，凭证留空则不启用） |
| `beijing` | `BEIJING_*` | 北京桶（可选，凭证留空则不启用） |

---

## 机器人典型工作流

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│ POST /api/  │────▶│ GET /api/    │────▶│ POST /api/jobs/  │
│ submit      │     │ status/:id   │     │ :id/{pause,      │
│             │     │ (轮询)        │     │  resume,cancel}  │
└─────────────┘     └──────────────┘     └──────────────────┘
```

1. **提交**：`POST /api/submit`（批量 URL）或 `POST /upload`（本地文件）
2. **轮询**：`GET /api/status/:id`，直到 `status` 变为 `done`/`failed`/`cancelled`
3. **控制**：按需 `pause` / `resume` / `cancel`
4. **查询**：`GET /api/files`（文件库）、`GET /api/objects`（桶对象）

> 任务进度推送也可用 Socket.IO（WebSocket），避免轮询。见下方 [实时推送](#实时推送socketio)。

---

## 接口详情

### 任务提交

#### POST /api/submit

批量提交 URL，自动下载并上传到 bucket。**机器人首选入口。**

```http
POST /api/submit
Content-Type: application/json
X-API-Key: YOUR_KEY

{
  "urls": ["https://example.com/a.zip", "https://example.com/b.zip"],
  "prefix": "backups/2026"
}
```

**参数**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `urls` | `string[]` | 是 | 1~50 个 URL，需 `http://` 或 `https://` 开头 |
| `prefix` | `string` | 否 | 对象 key 前缀（默认读 `DEFAULT_PREFIX` 环境变量） |

**响应** `200`：

```json
{
  "submitted": 2,
  "jobs": [
    {"url": "https://...", "job_id": 5, "object_key": "files/backups/2026/a.zip", "filename": "a.zip", "status": "queued"}
  ],
  "errors": [
    {"url": "https://bad", "error": "同名文件已存在：files/backups/2026/a.zip"}
  ]
}
```

> 同名拒传：目标 key 已存在时该 URL 放入 `errors`，不中断其余提交。无成功提交时返回 `400`。

---

#### POST /upload

上传本地文件（multipart/form-data）。适合机器人上传二进制文件。

```http
POST /upload
X-API-Key: YOUR_KEY
Content-Type: multipart/form-data

file=<二进制>
prefix=backups/2026
bucket=self          # 可选：self | bucket2 | beijing
key=custom/path.zip  # 可选：自定义完整 object key（覆盖 prefix）
datasource_id=3      # 可选
```

> 同名拒传：目标 key 已存在时返回 `400`。机器人默认获得 JSON 响应。

**响应**：

```json
{"status": "ok", "message": "「a.zip」已加入上传队列（1.50 GiB）。", "job_id": 5, "object_key": "...", "filename": "a.zip", "size": 1610612736}
```

---

### 任务状态查询

#### GET /api/status/:job_id

查询单个任务及其关联文件。

```http
GET /api/status/5
X-API-Key: YOUR_KEY
```

**响应**：

```json
{
  "job": {
    "id": 5, "kind": "fetch", "status": "uploading",
    "filename": "photo.jpg", "object_key": "files/photo.jpg",
    "source": "https://...", "size": 10240, "progress": 5120,
    "error": null, "cancelled": false, "paused": false,
    "created_at": 1234567890, "started_at": 1234567891, "finished_at": null
  },
  "file": {
    "id": 3, "status": "pending", "md5": "abc123", "size": 10240,
    "uploaded": 0, "uploaded_bucket2": 0, "uploaded_beijing": 0,
    "bucket": "mybucket", "object_key": "files/photo.jpg",
    "synced_at": null, "error": null
  }
}
```

> `file` 为 `null` 表示该 job 无关联文件记录。

#### GET /api/jobs

最近 50 条任务。

```http
GET /api/jobs
X-API-Key: YOUR_KEY
```

**响应**：`JobUpdate[]`（同 `/api/status` 中 `job` 的格式）

---

### 任务控制

#### POST /api/jobs/:job_id/cancel

取消任务（排队中或传输中均可）。

```http
POST /api/jobs/5/cancel
X-API-Key: YOUR_KEY
```

**响应**：

```json
{"status": "ok", "message": "已请求取消。", "job": {"id": 5, "status": "cancelled", ...}}
```

> 排队中的任务立即标记 `cancelled`；传输中的任务由回调中止后标记。

#### POST /api/jobs/:job_id/pause

暂停任务。排队中的任务会被 worker 跳过；传输中的任务阻塞在当前进度。

```http
POST /api/jobs/5/pause
X-API-Key: YOUR_KEY
```

**响应**：

```json
{"status": "ok", "message": "已暂停", "job": {"id": 5, "status": "uploading", "paused": true, ...}}
```

> 仅 `queued` / `uploading` 状态可暂停，其余返回 `400`。

#### POST /api/jobs/:job_id/resume

恢复暂停的任务。排队任务会重新入队；传输任务解除阻塞继续。

```http
POST /api/jobs/5/resume
X-API-Key: YOUR_KEY
```

**响应**：

```json
{"status": "ok", "message": "已恢复", "job": {"id": 5, "status": "uploading", "paused": false, ...}}
```

---

### 文件库管理

#### GET /api/files

分页查询文件库。

```http
GET /api/files?page=1&page_size=20&q=backup&status=synced
X-API-Key: YOUR_KEY
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `page` | 1 | 页码 |
| `page_size` | 20 | 每页条数（max 200） |
| `q` | — | 按 `filename` / `source_url` 模糊匹配 |
| `status` | — | `pending` / `synced` / `failed` / `deleted` / `cancelled` |

**响应**：

```json
{
  "items": [FileItem, ...],
  "total": 123, "page": 1, "page_size": 20
}
```

#### PATCH /api/files/:file_id

编辑文件记录（所有字段可选）。

```http
PATCH /api/files/3
X-API-Key: YOUR_KEY
Content-Type: application/json

{"status": "synced", "uploaded": true, "md5": "newhash"}
```

#### DELETE /api/files/:file_id

删除文件记录（仅数据库，不影响桶中对象）。

#### POST /api/files/:file_id/upload-cloud

将服务器本地文件上传到自己桶1（需先 `download-server`）。

```json
// 请求体（可选）
{"key": "custom/object/key"}
```

#### POST /api/files/:file_id/upload-bucket2

上传到自己桶2（需 `B2_2_*` 环境变量已配置）。请求体同 `upload-cloud`。

#### POST /api/files/:file_id/upload-beijing

上传到北京桶（需 `BEIJING_*` 环境变量已配置）。请求体同 `upload-cloud`。

#### POST /api/files/:file_id/download-server

从自己桶1下载到服务器 `SERVER_FILE_ROOT`。

#### POST /api/files/:file_id/download-server-bucket2

从自己桶2下载到服务器。

#### POST /api/files/:file_id/download-server-beijing

从北京桶下载到服务器。

#### POST /api/files/:file_id/check

重新检测文件在指定位置是否存在，不存在则自动更新记录。

```http
POST /api/files/3/check
X-API-Key: YOUR_KEY
Content-Type: application/json

{"target": "local"}
```

| target | 检测内容 | 不存在时更新 |
|--------|----------|-------------|
| `local` | 服务器本地文件（`SERVER_FILE_ROOT`） | `local_path = NULL` |
| `cloud` | 自己桶1中的对象 | `uploaded = 0, status = 'pending'` |
| `bucket2` | 自己桶2中的对象 | `uploaded_bucket2 = 0` |
| `beijing` | 北京桶中的对象 | `uploaded_beijing = 0` |

> 检测存在时会顺带更新 `size`（本地取文件 stat，桶内取对象 ContentLength）。

**响应**：

```json
{"target": "local", "exists": true, "file": {FileItem}}
```

---

### 桶对象管理

#### GET /api/objects

列出桶内对象（分页）。

```http
GET /api/objects?bucket=self&prefix=backups/&q=2026&page=1&page_size=50
X-API-Key: YOUR_KEY
```

> `bucket` 可选 `self`（默认）/ `bucket2` / `beijing`。

**响应**：

```json
{
  "prefix": "backups/",
  "bucket": "self",
  "objects": [{"key": "...", "size": 1024, "last_modified": 1234567890}],
  "total": 42, "page": 1, "page_size": 50
}
```

#### DELETE /api/objects

删除桶对象。

```json
{"key": "path/to/object.zip", "bucket": "self"}
```

> `bucket` 可选 `self`（默认）/ `bucket2` / `beijing`。删除成功后本地文件库对应桶的上传标记自动清零（自己桶1 另标记 `status=deleted`）。

#### POST /api/objects/rename

重命名 / 移动桶对象（copy + delete）。

```json
{"bucket": "self", "from_key": "old/path", "to_key": "new/path"}
```

#### GET /download

流式下载桶对象到客户端。

```http
GET /download?key=path/to/file.zip&bucket=self&apikey=YOUR_KEY
```

> 浏览器直跳用，返回二进制流。`bucket` 可选 `self` / `bucket2` / `beijing`。

---

### 服务器文件管理

需配置 `SERVER_FILE_ROOT` 环境变量。

#### GET /api/server-files

列出服务器本地文件。

```json
{"root": "/data/files", "total_size": 12345678, "files": [{"path": "a.txt", "size": 123, "absolute": "/data/files/a.txt"}]}
```

#### POST /server-upload

上传服务器本地文件到 bucket（FormData：`path` + `prefix`）。

#### POST /server-download

从 bucket 下载到服务器路径（FormData：`key` + `destination`）。

#### GET /server-file/download

浏览器下载服务器文件（`?path=relative/path`）。

#### DELETE /api/server-files

删除服务器文件（`?path=relative/path`）。

---

### 系统

#### GET /api/auth

鉴权探测 + 应用信息。机器人可用它验证 key 是否有效。

```json
{
  "app": "b2-file-manager", "bucket": "mybucket",
  "default_prefix": "",
  "bucket2_enabled": false, "bucket2_bucket": "",
  "beijing_enabled": false, "beijing_bucket": "",
  "bucket_private": true, "bucket_private_note": "..."
}
```

#### GET /api/bucket-health

检测桶连通性 + 元数据（延迟、region、版本控制、公开状态等）。

---

### 数据源管理

#### GET /api/scripts

数据源列表。

#### POST /scripts

新增数据源（FormData：`name` + `script_path`? + `description`?）。

#### POST /scripts/delete

删除数据源（FormData：`id`）。

---

## 实时推送（Socket.IO）

避免轮询，可用 WebSocket 接收任务进度更新。

```javascript
import { io } from "socket.io-client"

const socket = io({
  transports: ["websocket", "polling"],
  query: { apikey: "YOUR_KEY" }
})

// 连接时收到全量快照
socket.on("jobs_snapshot", (jobs) => console.log(jobs))

// 每次任务变化（进度更新 ~0.5s、状态变化、暂停/恢复等）
socket.on("job_update", (job) => {
  console.log(job.id, job.status, job.progress, job.paused)
})
```

**JobUpdate 字段**：

```typescript
interface JobUpdate {
  id: number
  kind: string           // fetch | upload | upload_bucket2 | upload_beijing | download | download_bucket2 | download_beijing
  status: string         // queued | uploading | done | failed | cancelled
  filename: string
  object_key: string
  progress: number       // 已传输字节
  size: number           // 总字节
  error: string | null
  source: string | null
  created_at: number     // Unix 时间戳（秒）
  started_at: number | null
  finished_at: number | null
  cancelled: boolean
  paused: boolean
}
```

---

## 错误处理

### 错误响应格式

错误响应有两种 JSON 格式（机器人建议同时检查 `error` 和 `message` 字段）：

```json
// 格式 A：大多数 /api/* 端点
{"error": "错误描述"}

// 格式 B：表单提交类端点（/upload, /server-upload, /url-upload, /scripts 等）
{"status": "error", "message": "错误描述"}
```

> 所有端点（含格式 B）对机器人均返回 JSON，无需 `Accept: application/json` header。
> 认证失败统一返回格式 A：`{"error": "未授权"}`。

### 常见错误码

| HTTP | 场景 |
|------|------|
| `400` | 参数缺失 / 同名文件已存在 / 状态不允许操作 |
| `401` | apikey 缺失或无效 |
| `404` | 任务 / 文件 / 对象不存在 |
| `500` | 服务器内部错误（文件落盘失败等） |
| `502` | 桶操作失败（B2/Boto3 异常） |

---

## 并发模型

- **多 worker**：默认 `MAX_WORKERS=3` 个线程并行处理任务。通过环境变量调整。
- **队列**：`queue.Queue` 天然线程安全，提交即入队。
- **暂停**：暂停的任务占用一个 worker 线程（阻塞在回调），不影响其它 worker 处理新任务。
- **取消**：内存标志 + 回调检查，立即中止传输。排队中取消直接标记。

---

## Python 示例

```python
import requests
import time

BASE = "https://your-host"
HEADERS = {"X-API-Key": "YOUR_KEY", "Content-Type": "application/json"}

# 提交
r = requests.post(f"{BASE}/api/submit", headers=HEADERS,
                  json={"urls": ["https://example.com/big.zip"], "prefix": "data"})
job_id = r.json()["jobs"][0]["job_id"]

# 轮询
while True:
    s = requests.get(f"{BASE}/api/status/{job_id}", headers=HEADERS).json()
    job = s["job"]
    print(f"{job['status']} {job['progress']}/{job['size']}")
    if job["status"] in ("done", "failed", "cancelled"):
        break
    time.sleep(1)

# 暂停示例
requests.post(f"{BASE}/api/jobs/{job_id}/pause", headers=HEADERS)
# ... 稍后恢复
requests.post(f"{BASE}/api/jobs/{job_id}/resume", headers=HEADERS)
```

---

## 已知限制

1. **无 webhook 回调**：任务完成不会主动通知，需轮询 `/api/status/:id` 或用 Socket.IO。
2. **无批量控制**：暂停 / 恢复 / 取消只能逐个调用，无批量端点。
3. **无速率限制**：请自行控制调用频率。
4. **gunicorn 需单 worker**：任务队列在进程内存中，gunicorn 必须保持 `--workers 1`（多进程会导致队列分裂）。
