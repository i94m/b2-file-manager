import * as React from "react"
import { ThemeProvider, useTheme } from "next-themes"
import { JobsProvider, useJobs } from "@/lib/use-jobs"
import { AuthGuard } from "@/components/auth-guard"
import { RefreshCw, Search, Moon, Sun } from "lucide-react"

import { type Datasource, type FileItem } from "@/lib/types"
import { getFiles, getScripts } from "@/lib/api"
import { useAppInfo } from "@/components/auth-guard"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { FilesDataTable } from "@/components/files-data-table"
import {
  DownloadDialog,
  FetchUrlDialog,
  UploadDialog,
} from "@/components/action-dialogs"
import { ConnectionStatus, JobsTable } from "@/components/job-status-bar"
import { ServerFilesSection } from "@/components/server-files-section"

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => setTheme(dark ? "light" : "dark")}
      title="切换主题"
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  )
}

function AppShell() {
  const appInfo = useAppInfo()
  const bucket = appInfo?.bucket ?? ""
  const defaultPrefix = appInfo?.default_prefix ?? ""
  const bucketPrivateNote = appInfo?.bucket_private_note ?? ""
  const bucketPrivate = appInfo?.bucket_private ?? null

  const [files, setFiles] = React.useState<FileItem[]>([])
  const [scripts, setScripts] = React.useState<Datasource[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [pageSize] = React.useState(20)
  const [loading, setLoading] = React.useState(true)

  const [q, setQ] = React.useState("")
  const [debouncedQ, setDebouncedQ] = React.useState("")
  const [status, setStatus] = React.useState("all")
  const [refreshing, setRefreshing] = React.useState(false)

  // 搜索防抖：q 变化后 400ms 才更新 debouncedQ（触发列表请求）
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 400)
    return () => clearTimeout(t)
  }, [q])

  // 脚本列表只加载一次
  React.useEffect(() => {
    getScripts()
      .then(setScripts)
      .catch((e) => console.error(e))
  }, [])

  // 文件列表：分页 / 状态 / 防抖后的搜索词 变化时加载
  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    getFiles({
      page,
      page_size: pageSize,
      q: debouncedQ || undefined,
      status: status === "all" ? undefined : status,
    })
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
  }, [page, pageSize, debouncedQ, status])

  // 强制重新拉取当前页（供刷新按钮、删除/录入完成回调使用）
  const loadFiles = React.useCallback(async () => {
    setLoading(true)
    try {
      const data = await getFiles({
        page,
        page_size: pageSize,
        q: debouncedQ || undefined,
        status: status === "all" ? undefined : status,
      })
      setFiles(data.items)
      setTotal(data.total)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, debouncedQ, status])

  const refresh = async () => {
    setRefreshing(true)
    await loadFiles()
    setRefreshing(false)
  }

  // 任务完成时自动静默刷新文件列表（不闪骨架屏）
  const { jobs } = useJobs()
  const terminalRef = React.useRef<Set<number>>(new Set())
  React.useEffect(() => {
    let hasNew = false
    for (const job of Object.values(jobs)) {
      if (["done", "failed", "cancelled", "error"].includes(job.status)) {
        if (!terminalRef.current.has(job.id)) {
          terminalRef.current.add(job.id)
          hasNew = true
        }
      }
    }
    if (!hasNew) return
    const t = setTimeout(() => {
      getFiles({
        page,
        page_size: pageSize,
        q: debouncedQ || undefined,
        status: status === "all" ? undefined : status,
      })
        .then((data) => {
          setFiles(data.items)
          setTotal(data.total)
        })
        .catch((e) => console.error(e))
    }, 500)
    return () => clearTimeout(t)
  }, [jobs, page, pageSize, debouncedQ, status])

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {/* Header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">B2 文件管理</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs">
                <span className="size-1.5 rounded-full bg-blue-500" />
                Bucket: <code className="font-mono font-medium text-foreground">{bucket || "…"}</code>
              </span>
              <ConnectionStatus />
            </div>
          </div>
          <ThemeToggle />
        </header>

        {/* Bucket 公开告警 */}
        {bucketPrivate === false && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            ⚠️ {bucketPrivateNote}
          </div>
        )}

        {/* 工具栏 */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <FetchUrlDialog
            defaultPrefix={defaultPrefix}
            scripts={scripts}
            onDone={refresh}
          />
          <UploadDialog
            defaultPrefix={defaultPrefix}
            scripts={scripts}
            onDone={refresh}
          />
          <DownloadDialog onDone={refresh} />

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="w-[28rem] pl-8"
                placeholder="搜索文件名 / MD5 / 来源"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                <SelectItem value="synced">已上传</SelectItem>
                <SelectItem value="pending">待上传</SelectItem>
                <SelectItem value="failed">失败</SelectItem>
                <SelectItem value="deleted">已删除</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" onClick={refresh} title="刷新" disabled={refreshing}>
              <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
            </Button>
          </div>
        </div>

        {/* 文件库 DataTable */}
        <FilesDataTable
          data={files}
          scripts={scripts}
          total={total}
          page={page}
          pageSize={pageSize}
          loading={loading}
          onPageChange={setPage}
          onDeleted={loadFiles}
        />

        {/* 任务记录表格 */}
        <div className="mt-4">
          <JobsTable />
        </div>

        {/* 本地文件（SERVER_FILE_ROOT） */}
        <div className="mt-6">
          <ServerFilesSection />
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <AuthGuard>
        <JobsProvider>
          <TooltipProvider>
            <AppShell />
            <Toaster richColors position="top-right" />
          </TooltipProvider>
        </JobsProvider>
      </AuthGuard>
    </ThemeProvider>
  )
}
