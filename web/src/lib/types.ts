/** 后端 files 表的一行（GET /api/files 返回的 item）。 */
export interface FileItem {
  id: number
  job_id: number | null
  object_key: string
  filename: string | null
  md5: string | null
  size: number
  bucket: string
  source_url: string | null
  uploaded: number // 0/1
  status: string // pending | synced | failed | deleted
  datasource_id: number | null
  local_path: string | null // 已下载到服务器 SERVER_FILE_ROOT 的相对路径
  created_at: number
  updated_at: number
  synced_at: number | null
  error: string | null
}

/** GET /api/files 的响应。 */
export interface FilesResponse {
  items: FileItem[]
  total: number
  page: number
  page_size: number
}

/** 本地文件列表里的一项（SERVER_FILE_ROOT 目录）。 */
export interface ServerFile {
  path: string
  size: number
  absolute: string
}

/** GET /api/server-files 的响应。 */
export interface ServerFilesResponse {
  root: string | null
  total_size: number
  files: ServerFile[]
}

/** 数据源（原脚本）：name + script_path（允许空，仅记录不执行）。 */
export interface Datasource {
  id: number
  name: string
  script_path: string | null
  description: string | null
  created_at: number
  updated_at: number
}

/** GET / 根路由的引导信息。 */
export interface AppInfo {
  app: string
  bucket: string
  default_prefix: string
  bucket_private: boolean | null
  bucket_private_note: string
}

/** Socket.IO job_update 事件（与后端 job_payload 对齐）。 */
export interface JobUpdate {
  id: number
  kind: string
  status: string
  filename: string
  object_key: string
  progress: number
  size: number
  error: string | null
  source: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  cancelled: boolean
}

/** 单个 job 的实时进度统计（由前端基于 job_update 序列推算）。 */
export interface JobStats {
  /** 0~100 的百分比。 */
  percent: number
  /** 瞬时速率（字节/秒）。 */
  rate: number
  /** 剩余字节数。 */
  remaining: number
  /** 预计剩余秒数（无速率时为 null）。 */
  etaSec: number | null
  /** 已用秒数（从 started_at 起，无则 null）。 */
  elapsedSec: number | null
}
