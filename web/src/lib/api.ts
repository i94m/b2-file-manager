import type { AppInfo, Datasource, FilesResponse, ServerFilesResponse } from "./types"

/**
 * apikey 全程从 URL ?apikey= 取，不缓存到 localStorage。
 * 所有请求统一走 X-API-Key header（后端 apikey_ok() 也支持 query / Bearer）。
 */
export function getApiKey(): string {
  return new URLSearchParams(window.location.search).get("apikey") ?? ""
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { "X-API-Key": getApiKey() }
  if (json) h["Accept"] = "application/json"
  return h
}

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    throw new Error("未授权：apikey 无效或缺失")
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `请求失败 (HTTP ${res.status})`)
  }
  return data as T
}

/** GET /api/auth — 鉴权探测 + 应用信息（bucket、安全状态、默认前缀）。 */
export async function checkAuth(): Promise<AppInfo> {
  const res = await fetch("/api/auth", { headers: headers() })
  return handle<AppInfo>(res)
}

/** GET /api/files — 分页文件列表。 */
export async function getFiles(params: {
  page?: number
  page_size?: number
  q?: string
  status?: string
}): Promise<FilesResponse> {
  const qs = new URLSearchParams()
  if (params.page) qs.set("page", String(params.page))
  if (params.page_size) qs.set("page_size", String(params.page_size))
  if (params.q) qs.set("q", params.q)
  if (params.status) qs.set("status", params.status)
  const res = await fetch(`/api/files?${qs}`, { headers: headers() })
  return handle<FilesResponse>(res)
}

/** GET /api/scripts — 数据源列表（id→名称映射）。 */
export async function getScripts(): Promise<Datasource[]> {
  const res = await fetch("/api/scripts", { headers: headers() })
  return handle<Datasource[]>(res)
}

/** 表单提交类响应（与后端 respond() 对齐）。 */
export interface FormResult {
  status: "ok" | "error"
  message: string
  job_id?: number
  file_id?: number
  object_key?: string
  filename?: string
  size?: number
}

/** POST /upload — 本地文件上传到 bucket（FormData）。 */
export async function uploadFile(
  file: File,
  opts: { prefix?: string; datasourceId?: number } = {},
): Promise<FormResult> {
  const form = new FormData()
  form.append("file", file)
  if (opts.prefix) form.append("prefix", opts.prefix)
  if (opts.datasourceId) form.append("datasource_id", String(opts.datasourceId))
  const res = await fetch("/upload", { method: "POST", headers: headers(true), body: form })
  return handle<FormResult>(res)
}

/** POST /url-upload — 录入链接，只登记不自动上传。 */
export async function urlUpload(
  url: string,
  opts: { prefix?: string; datasourceId?: number } = {},
): Promise<FormResult> {
  const form = new FormData()
  form.append("url", url)
  if (opts.prefix) form.append("prefix", opts.prefix)
  if (opts.datasourceId) form.append("datasource_id", String(opts.datasourceId))
  const res = await fetch("/url-upload", { method: "POST", headers: headers(true), body: form })
  return handle<FormResult>(res)
}

/** POST /api/files/:id/upload-cloud — 上传本地文件到云 bucket。 */
export async function uploadToCloud(fileId: number): Promise<FormResult> {
  const res = await fetch(`/api/files/${fileId}/upload-cloud`, {
    method: "POST",
    headers: headers(true),
  })
  return handle<FormResult>(res)
}

/** POST /api/jobs/:id/cancel — 请求取消一个进行中的任务。 */
export async function cancelJob(
  jobId: number,
): Promise<{ status: string; message: string; job?: unknown }> {
  const res = await fetch(`/api/jobs/${jobId}/cancel`, {
    method: "POST",
    headers: headers(true),
  })
  return handle(res)
}

/** POST /api/files/:id/download-server — 下载 bucket 对象到服务器 SERVER_FILE_ROOT。 */
export async function downloadServer(fileId: number): Promise<FormResult> {
  const res = await fetch(`/api/files/${fileId}/download-server`, {
    method: "POST",
    headers: headers(true),
  })
  return handle<FormResult>(res)
}

/** POST /server-download — 从 bucket 下载对象到服务器目录。 */
export async function serverDownload(
  key: string,
  destination: string,
): Promise<FormResult> {
  const form = new FormData()
  form.append("key", key)
  form.append("destination", destination)
  const res = await fetch("/server-download", { method: "POST", headers: headers(true), body: form })
  return handle<FormResult>(res)
}

/** DELETE /api/files/:id — 删除文件记录（同时从 bucket 删除对象）。 */
export async function deleteFile(fileId: number): Promise<{ deleted: boolean; file_id: number }> {
  const res = await fetch(`/api/files/${fileId}`, {
    method: "DELETE",
    headers: headers(true),
  })
  return handle(res)
}

/** DELETE /api/objects — 删除 bucket 对象。 */
export async function deleteObject(key: string): Promise<{ deleted: boolean; key: string }> {
  const res = await fetch("/api/objects", {
    method: "DELETE",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  })
  return handle(res)
}

/** 下载链接（浏览器直跳，后端流式返回，走 query apikey）。 */
export function downloadUrl(key: string): string {
  return `/download?key=${encodeURIComponent(key)}&apikey=${encodeURIComponent(getApiKey())}`
}

/** GET /api/server-files — 本地文件列表（SERVER_FILE_ROOT）。 */
export async function getServerFiles(): Promise<ServerFilesResponse> {
  const res = await fetch("/api/server-files", { headers: headers() })
  return handle<ServerFilesResponse>(res)
}

/** DELETE /api/server-files — 删除本地文件。 */
export async function deleteServerFile(
  path: string,
): Promise<{ deleted: boolean; path: string }> {
  const res = await fetch(`/api/server-files?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: headers(),
  })
  return handle(res)
}

/** 本地文件下载链接（服务器 → 浏览器）。 */
export function serverFileDownloadUrl(path: string): string {
  return `/server-file/download?path=${encodeURIComponent(path)}&apikey=${encodeURIComponent(getApiKey())}`
}
