import * as React from "react"
import { ThemeProvider, useTheme } from "next-themes"
import { JobsProvider, useJobs } from "@/lib/use-jobs"
import { BucketsProvider, useBuckets } from "@/lib/use-buckets"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { FilesDataTable } from "@/components/files-data-table"
import { FetchUrlDialog } from "@/components/action-dialogs"
import { ConnectionStatus, JobsTable } from "@/components/job-status-bar"
import { BucketStatusBadges } from "@/components/bucket-status-badges"
import { ServerFilesSection } from "@/components/server-files-section"
import { BucketBrowserSection } from "@/components/bucket-browser-section"
import { BucketManager } from "@/components/bucket-manager"

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
  const { buckets } = useBuckets()
  const defaultPrefix = appInfo?.default_prefix ?? ""
  const bucketPrivateNote = appInfo?.bucket_private_note ?? ""
  const bucketPrivate = appInfo?.bucket_private ?? null

  const [files, setFiles] = React.useState<FileItem[]>([])

  /** 单条文件记录更新（检测存在性等轻量操作，不触发全表重载）。 */
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
      <main className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6">
        {/* Header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">文件同步助手</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <BucketStatusBadges trailing={<ConnectionStatus />} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <BucketManager />
            <ThemeToggle />
          </div>
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

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="w-[28rem] pl-8"
                placeholder="搜索文件名 / 原始链接"
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

        {/* 源文件管理 */}
        <h2 className="mb-3 text-lg font-semibold">源文件管理</h2>
        <FilesDataTable
          data={files}
          scripts={scripts}
          buckets={buckets}
          total={total}
          page={page}
          pageSize={pageSize}
          loading={loading}
          onPageChange={setPage}
          onDeleted={loadFiles}
          onFileUpdated={patchFile}
        />

        {/* 文件库 tabs（本地文件 + 各桶）与 任务记录 并列 */}
        <div className="mt-6 flex flex-col gap-4 xl:flex-row xl:items-start">
          <Tabs defaultValue="local" className="min-w-0 flex-1">
            <TabsList>
              <TabsTrigger value="local">本地文件</TabsTrigger>
              {buckets.map((b) => (
                <TabsTrigger key={b.id} value={String(b.id)} title={b.bucket_name}>
                  {b.name}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="local">
              <ServerFilesSection
                defaultPrefix={defaultPrefix}
                scripts={scripts}
                onUploaded={refresh}
              />
            </TabsContent>
            {buckets.map((b) => (
              <TabsContent key={b.id} value={String(b.id)}>
                <BucketBrowserSection
                  title={`${b.name} · ${b.bucket_name}`}
                  bucketId={b.id}
                  defaultPrefix={defaultPrefix}
                />
              </TabsContent>
            ))}
          </Tabs>
          {Object.keys(jobs).length > 0 && (
            <div className="min-w-0 flex-1">
              <JobsTable />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <AuthGuard>
        <BucketsProvider>
          <JobsProvider>
            <TooltipProvider>
              <AppShell />
              <Toaster richColors position="top-right" />
            </TooltipProvider>
          </JobsProvider>
        </BucketsProvider>
      </AuthGuard>
    </ThemeProvider>
  )
}
