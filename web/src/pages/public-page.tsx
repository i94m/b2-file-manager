import * as React from "react"
import { RefreshCw, Search } from "lucide-react"

import { type Datasource, type FileItem } from "@/lib/types"
import { getFiles, getScripts } from "@/lib/api"
import { useTerminalFileRefresh } from "@/lib/use-terminal-file-refresh"
import { useBuckets } from "@/lib/use-buckets"
import { useJobs } from "@/lib/use-jobs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FetchUrlDialog } from "@/components/action-dialogs"
import { ConnectionStatus } from "@/components/job-status-bar"
import { PublicFilesTable, type ActiveFileStatus } from "@/components/public-files-table"
import { ThemeToggle } from "@/components/theme-toggle"

/**
 * 对外展示页（/）：只读的文件 × 桶同步状态矩阵 + 链接录入。
 * 无管理操作（任务控制/桶管理/编辑删除均无）；同步状态经 Socket.IO 实时推送。
 */
function PublicPage() {
  const { buckets } = useBuckets()

  const [files, setFiles] = React.useState<FileItem[]>([])

  /** 单条文件记录更新（任务终态后行级 patch，不触发全表重载）。 */
  const patchFile = React.useCallback((updated: FileItem) => {
    setFiles((prev) => prev.map((f) => (f.id === updated.id ? updated : f)))
  }, [])
  const [scripts, setScripts] = React.useState<Datasource[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [pageSize] = React.useState(20)
  const [loading, setLoading] = React.useState(true)

  const [q, setQ] = React.useState("")
  const [debouncedQ, setDebouncedQ] = React.useState("")
  const [refreshing, setRefreshing] = React.useState(false)

  // 搜索防抖：q 变化后 400ms 才更新 debouncedQ（触发列表请求）
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 400)
    return () => clearTimeout(t)
  }, [q])

  // 数据源列表：仅供「新增文件」弹窗下拉
  React.useEffect(() => {
    getScripts()
      .then(setScripts)
      .catch((e) => console.error(e))
  }, [])

  // 文件列表：分页 / 防抖后的搜索词 变化时加载（公开页恒展示全部状态）
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    getFiles({ page, page_size: pageSize, q: debouncedQ || undefined })
      .then((data) => {
        if (cancelled) return
        setFiles(data.items)
        setTotal(data.total)
      })
      .catch((e) => console.error(e))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [page, pageSize, debouncedQ])

  // 强制重新拉取当前页（供刷新按钮、录入完成回调使用）
  const loadFiles = React.useCallback(async () => {
    setLoading(true)
    try {
      const data = await getFiles({ page, page_size: pageSize, q: debouncedQ || undefined })
      setFiles(data.items)
      setTotal(data.total)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, debouncedQ])

  const refresh = async () => {
    setRefreshing(true)
    await loadFiles()
    setRefreshing(false)
  }

  // 任务终态后行级刷新（上传/下载完成后对应行的桶列自动变绿）
  useTerminalFileRefresh(files, patchFile)

  // 活跃任务（排队中/上传中）→ object_key 映射：正在传输的文件即使不在当前页
  // （或尚未登记为文件记录）也在列表展示实时状态。同一 object_key 多个任务时
  // 取最新（id 大者），与 files.job_id 的「最近一次任务」语义一致。
  const { jobs } = useJobs()
  const activeMap = React.useMemo(() => {
    const map = new Map<string, ActiveFileStatus>()
    for (const job of Object.values(jobs)) {
      if (job.status !== "queued" && job.status !== "uploading") continue
      const target: ActiveFileStatus["target"] =
        (job.kind === "upload" || job.kind === "transfer") && job.bucket_id != null ? job.bucket_id : "local"
      const prev = map.get(job.object_key)
      if (!prev || prev.job.id < job.id) {
        map.set(job.object_key, { job, target })
      }
    }
    return map
  }, [jobs])

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6">
        {/* Header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">BucketHub 文件同步</h1>
            <ConnectionStatus />
          </div>
          <ThemeToggle />
        </header>

        {/* 工具栏：链接录入 + 搜索 + 刷新 */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <FetchUrlDialog defaultPrefix="" scripts={scripts} onDone={refresh} />
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="w-[28rem] pl-8"
                placeholder="搜索，多关键词空格分隔..."
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Button variant="ghost" size="icon" onClick={refresh} title="刷新" disabled={refreshing}>
              <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
            </Button>
          </div>
        </div>

        {/* 文件 × 桶同步状态矩阵（只读，含正在上传/下载的活跃任务行） */}
        <PublicFilesTable
          data={files}
          buckets={buckets}
          activeMap={activeMap}
          total={total}
          page={page}
          pageSize={pageSize}
          loading={loading}
          onPageChange={setPage}
        />
      </main>
    </div>
  )
}

export default PublicPage
