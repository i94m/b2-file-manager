import * as React from "react"
import { ThemeProvider, useTheme } from "next-themes"
import { JobsProvider, useJobs } from "@/lib/use-jobs"
import { BucketsProvider, useBuckets } from "@/lib/use-buckets"
import { AuthGuard } from "@/components/auth-guard"
import { ArrowUpDown, FolderOpen, HardDrive, RefreshCw, Search, Moon, Sun } from "lucide-react"
import { getBucketHealth } from "@/lib/api"
import { HealthDot } from "@/components/bucket-health"

import { type BucketHealthEntry, type Datasource, type FileItem } from "@/lib/types"
import { getFile, getFiles, getScripts } from "@/lib/api"
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
import { ServerFilesSection } from "@/components/server-files-section"
import { BucketBrowserSection } from "@/components/bucket-browser-section"
import { BucketManager } from "@/components/bucket-manager"
import { DatasourceManager } from "@/components/datasource-manager"

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

  // 桶连通性：导航菜单内状态点 + hover 详情共用
  const [healthMap, setHealthMap] = React.useState<Record<number, BucketHealthEntry>>({})
  const checkHealth = React.useCallback(async () => {
    try {
      const data = await getBucketHealth()
      const map: Record<number, BucketHealthEntry> = {}
      data.buckets.forEach((b) => {
        map[b.id] = b.health
      })
      setHealthMap(map)
    } catch {
      /* 检测失败保持原状态 */
    }
  }, [])
  React.useEffect(() => {
    checkHealth()
  }, [checkHealth])

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
  /** 顶层模块切换：files=源文件管理 / transfers=上传管理 / local=本地文件 / bucket:<id>=各桶（动态）。 */
  const [section, setSection] = React.useState<string>("files")

  // 当前选中的桶被停用/删除时，回退到源文件管理
  React.useEffect(() => {
    if (section.startsWith("bucket:")) {
      const id = Number(section.slice("bucket:".length))
      const stillEnabled = buckets.some((b) => b.id === id && b.enabled)
      if (!stillEnabled) setSection("files")
    }
  }, [section, buckets])

  // 搜索防抖：q 变化后 400ms 才更新 debouncedQ（触发列表请求）
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 400)
    return () => clearTimeout(t)
  }, [q])

  // 数据源列表：初始加载 + 数据源管理变更后刷新
  const loadScripts = React.useCallback(() => {
    getScripts()
      .then(setScripts)
      .catch((e) => console.error(e))
  }, [])
  React.useEffect(() => {
    loadScripts()
  }, [loadScripts])

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

  // 任务结束时只更新受影响的行（按 job_id 匹配当前页），不整表刷新
  const { jobs } = useJobs()
  /** 进行中的任务数（上传管理 Tab 角标）。 */
  const activeJobs = Object.values(jobs).filter(
    (j) => j.status === "queued" || j.status === "uploading",
  ).length
  const terminalRef = React.useRef<Set<number>>(new Set())
  const filesRef = React.useRef(files)
  filesRef.current = files
  React.useEffect(() => {
    const finishedIds = new Set<number>()
    for (const job of Object.values(jobs)) {
      if (["done", "failed", "cancelled", "error"].includes(job.status)) {
        if (!terminalRef.current.has(job.id)) {
          terminalRef.current.add(job.id)
          finishedIds.add(job.id)
        }
      }
    }
    if (finishedIds.size === 0) return
    const affected = filesRef.current.filter(
      (f) => f.job_id !== null && finishedIds.has(f.job_id),
    )
    if (affected.length === 0) return
    const t = setTimeout(() => {
      affected.forEach((f) => {
        getFile(f.id).then(patchFile).catch((e) => console.error(e))
      })
    }, 500)
    return () => clearTimeout(t)
  }, [jobs, patchFile])

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-[1600px] px-4 py-8 sm:px-6">
        {/* Header */}
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">BucketHub</h1>
            <ConnectionStatus />
          </div>
          <div className="flex items-center gap-2">
            <BucketManager />
            <DatasourceManager scripts={scripts} onChanged={loadScripts} />
            <ThemeToggle />
          </div>
        </header>

        {/* Bucket 公开告警 */}
        {bucketPrivate === false && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            ⚠️ {bucketPrivateNote}
          </div>
        )}

        {/* 顶层模块切换（Tabs 样式）：源文件管理 / 上传管理 / 本地文件 / 各桶（含连通性状态） */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={section}
            onValueChange={setSection}
            className="min-w-0"
          >
            <TabsList className="flex-wrap">
              <TabsTrigger value="files" className="gap-1.5">
                <FolderOpen className="size-4" /> 源文件管理
              </TabsTrigger>
              <TabsTrigger value="transfers" className="gap-1.5">
                <ArrowUpDown className="size-4" /> 上传管理
                {activeJobs > 0 && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {activeJobs}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="local" className="gap-1.5">
                <HardDrive className="size-4" /> 本地文件
              </TabsTrigger>
              {buckets.filter((b) => b.enabled).map((b) => (
                <TabsTrigger
                  key={b.id}
                  value={`bucket:${b.id}`}
                  className="gap-1.5"
                >
                  <HealthDot entry={healthMap[b.id]} />
                  {b.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* 搜索 / 状态筛选只在源文件管理模块显示 */}
          {section === "files" && (
            <div className="flex flex-wrap items-center gap-2">
              <FetchUrlDialog
                defaultPrefix={defaultPrefix}
                scripts={scripts}
                onDone={refresh}
              />
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="w-[28rem] pl-8"
                  placeholder="文件名 / 链接 / 文件Key..."
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
          )}
        </div>

        {/* 模块内容（section 驱动，Tabs 仅作受控容器复用挂载/卸载行为） */}
        <Tabs value={section} onValueChange={setSection} className="mb-4">

          {/* 源文件管理：文件库表格 */}
          <TabsContent value="files">
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
          </TabsContent>

          {/* 上传管理：传输列表（上传/下载任务全宽） */}
          <TabsContent value="transfers">
            <JobsTable />
          </TabsContent>

          {/* 本地文件：服务器文件目录 */}
          <TabsContent value="local">
            <ServerFilesSection
              defaultPrefix={defaultPrefix}
              scripts={scripts}
              onUploaded={refresh}
            />
          </TabsContent>

          {/* 各桶：动态顶层 Tab（桶顺序沿用桶管理拖动排序） */}
          {buckets.map((b) => (
            <TabsContent key={b.id} value={`bucket:${b.id}`}>
              <BucketBrowserSection
                title={`${b.name} · ${b.bucket_name}`}
                bucketId={b.id}
                defaultPrefix={defaultPrefix}
                bucketName={b.name}
                bucketKey={b.bucket_name}
                health={healthMap[b.id]}
              />
            </TabsContent>
          ))}
        </Tabs>
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
              <Toaster />
            </TooltipProvider>
          </JobsProvider>
        </BucketsProvider>
      </AuthGuard>
    </ThemeProvider>
  )
}
