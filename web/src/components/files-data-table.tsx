import * as React from "react"
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ChevronLeft, ChevronRight, CloudUpload, Download, HardDriveDownload, Loader2, Pencil, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { type Datasource, type FileItem } from "@/lib/types"
import { cn, formatBytes, formatTime } from "@/lib/utils"
import {
  cancelJob,
  deleteFile,
  downloadServer,
  downloadUrl,
  updateFile,
  uploadToBeijing,
  uploadToCloud,
} from "@/lib/api"
import { useJobs } from "@/lib/use-jobs"
import { useConfirm } from "@/lib/use-confirm"
import { JobProgressBadge } from "@/components/progress-cell"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** 骨架行各列的宽度类（按 columns 顺序对齐，模拟真实数据宽度）。 */
function skeletonWidths(beijingEnabled: boolean): string[] {
  const widths = [
    "w-4",    // select
    "w-16",   // 数据源
    "w-28",   // 文件名称
    "w-20",   // 大小（居中）
    "w-16",   // 本地
    "w-16",   // 自己桶
  ]
  if (beijingEnabled) widths.push("w-16") // 北京桶
  widths.push("w-8", "w-24") // 操作、创建时间
  return widths
}

interface FilesDataTableProps {
  data: FileItem[]
  scripts: Datasource[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  beijingEnabled: boolean
  onPageChange: (page: number) => void
  onDeleted: () => void
}

/** 截断长文本 + tooltip 显示完整值。 */
function Truncate({ value, className }: { value: string | null; className?: string }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("block max-w-[12rem] truncate cursor-default", className)}>{value}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all">{value}</TooltipContent>
    </Tooltip>
  )
}

/** 状态文字：active=绿 / muted=正常灰 / queued=黄。失败时 hover 展示错误。 */
function StatusText({
  children,
  tone = "muted",
  error,
}: {
  children: React.ReactNode
  tone?: "active" | "muted" | "queued"
  error?: string | null
}) {
  const color =
    tone === "active"
      ? "text-emerald-600"
      : tone === "queued"
        ? "text-amber-500"
        : "text-muted-foreground"
  if (error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("cursor-help text-xs font-medium", color)}>{children}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-all">{error}</TooltipContent>
      </Tooltip>
    )
  }
  return <span className={cn("text-xs font-medium", color)}>{children}</span>
}

/** 单元格内的小图标按钮（可做 <a> 或 <button>）。 */
function IconBtn({
  icon: Icon,
  title,
  onClick,
  busy,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick?: () => void
  busy?: boolean
  href?: string
}) {
  const className =
    "inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
  if (href) {
    return (
      <a href={href} className={className} title={title}>
        <Icon className="size-3" />
      </a>
    )
  }
  return (
    <button type="button" onClick={onClick} disabled={busy} className={className} title={title}>
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
    </button>
  )
}

/** ── 上传目录历史（localStorage）── */
const DIR_HISTORY_KEY = "upload-dir-history"
const MAX_DIR_HISTORY = 8

function loadDirHistory(): string[] {
  try {
    const raw = localStorage.getItem(DIR_HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.slice(0, MAX_DIR_HISTORY) : []
  } catch {
    return []
  }
}

function pushDirHistory(dir: string) {
  const trimmed = dir.trim().replace(/^\/+|\/+$/g, "")
  if (!trimmed) return
  const current = loadDirHistory()
  const updated = [trimmed, ...current.filter((d) => d !== trimmed)].slice(0, MAX_DIR_HISTORY)
  try {
    localStorage.setItem(DIR_HISTORY_KEY, JSON.stringify(updated))
  } catch {
    /* ignore */
  }
}

/** 小型取消任务按钮（排队 / 上传中均可点击取消）。 */
function CancelJobBtn({ file }: { file: FileItem }) {
  const { jobs } = useJobs()
  const [cancelling, setCancelling] = React.useState(false)
  const [confirm, confirmDialog] = useConfirm()
  const job = file.job_id ? jobs[file.job_id] : undefined
  if (!job) return null

  const handleCancel = async () => {
    if (!await confirm({
      title: "取消任务",
      description: `确认取消任务「${job.filename}」？`,
      confirmText: "取消任务",
      destructive: true,
    })) return
    setCancelling(true)
    try {
      const r = await cancelJob(job.id)
      toast(r.message)
    } catch (e) {
      toast.error("取消失败", { description: (e as Error).message })
    } finally {
      setCancelling(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleCancel}
        disabled={cancelling}
        className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:opacity-50"
        title="取消任务"
      >
        {cancelling ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
      </button>
      {confirmDialog}
    </>
  )
}

/** 排队中黄字 + 取消按钮。 */
function QueuedLabel({ file }: { file: FileItem }) {
  return (
    <div className="flex items-center gap-0.5">
      <StatusText tone="queued">排队中</StatusText>
      <CancelJobBtn file={file} />
    </div>
  )
}

/** 校验目录输入（与后端 clean_prefix 规则一致：禁止 '..' 路径穿越）。 */
function validateDir(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parts = trimmed.replace(/\\/g, "/").split("/")
  if (parts.some((p) => p === "..")) return "目录不能包含 '..'"
  return null
}

/** 校验文件名：非空、无路径分隔符、不能是 '.' 或 '..'。 */
function validateFilename(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return "文件名不能为空"
  if (/[/\\]/.test(trimmed)) return "文件名不能包含路径分隔符"
  if (trimmed === "." || trimmed === "..") return "文件名无效"
  return null
}

/** 上传到桶 Dialog：输入目录 + 文件名，下方有最近目录历史快捷填充。 */
function UploadKeyDialog({
  file,
  bucket,
  onClose,
  onDone,
}: {
  file: FileItem
  bucket: "self" | "beijing"
  onClose: () => void
  onDone: () => void
}) {
  const [history] = React.useState(() => loadDirHistory())
  const [dir, setDir] = React.useState(history[0] ?? "")
  const [filename, setFilename] = React.useState(file.filename ?? "")
  const [busy, setBusy] = React.useState(false)

  const dirError = validateDir(dir)
  const nameError = validateFilename(filename)
  const hasError = !!dirError || !!nameError

  const submit = async () => {
    if (hasError) return
    const cleanDir = dir.trim().replace(/^\/+|\/+$/g, "")
    const cleanName = filename.trim()
    const key = cleanDir ? `${cleanDir}/${cleanName}` : cleanName
    setBusy(true)
    try {
      const fn = bucket === "beijing" ? uploadToBeijing : uploadToCloud
      const r = await fn(file.id, key)
      toast.success(r.message)
      if (cleanDir) pushDirHistory(cleanDir)
      onDone()
    } catch (e) {
      toast.error("上传失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !hasError) submit()
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            上传到{bucket === "beijing" ? "北京桶" : "自己桶"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="upload-dir">目录</Label>
            <Input
              id="upload-dir"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              onKeyDown={onEnter}
              placeholder="如 backups/2026"
              className={cn("font-mono text-sm", dirError && "border-destructive focus-visible:ring-destructive")}
              autoFocus
            />
            {dirError && (
              <p className="text-xs text-destructive">{dirError}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="upload-name">文件名</Label>
            <Input
              id="upload-name"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              onKeyDown={onEnter}
              className={cn("font-mono text-sm", nameError && "border-destructive focus-visible:ring-destructive")}
            />
            {nameError && (
              <p className="text-xs text-destructive">{nameError}</p>
            )}
          </div>
          {history.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground">最近目录（点击填充）</span>
              <div className="flex flex-wrap gap-1.5">
                {history.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDir(d)}
                    className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || hasError}>
            {busy ? "提交中…" : "上传"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 单元格内的紧凑操作按钮（图标+文字），失败时 hover 展示错误。 */
function CellButton({
  icon: Icon,
  label,
  title,
  onClick,
  busy,
  error,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  title: string
  onClick: () => void
  busy?: boolean
  error?: string | null
}) {
  const btn = (
    <Button variant="ghost" size="sm" onClick={onClick} disabled={busy} title={title} className="h-6 gap-1 px-1.5 text-xs text-muted-foreground">
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Icon className="size-3" />}
      {label}
    </Button>
  )
  if (error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent className="max-w-xs break-all">{error}</TooltipContent>
      </Tooltip>
    )
  }
  return btn
}

/** 本地列：排队→黄字 / 传输中→进度 / 已存在→绿字 / 否则→下载按钮。 */
function LocalCell({ file, onUpdated }: { file: FileItem; onUpdated: () => void }) {
  const { jobs } = useJobs()
  const [busy, setBusy] = React.useState(false)
  const job = file.job_id ? jobs[file.job_id] : undefined
  const isMyJob = job && (job.kind === "fetch" || job.kind === "download")

  if (isMyJob && job!.status === "queued") return <QueuedLabel file={file} />
  if (isMyJob && job!.status === "uploading") return (
    <div className="flex items-center gap-0.5">
      <JobProgressBadge file={file} />
      <CancelJobBtn file={file} />
    </div>
  )

  if (file.local_path) return <StatusText tone="active">已存在</StatusText>

  const handleDownload = async () => {
    setBusy(true)
    try {
      const r = await downloadServer(file.id)
      toast.success(r.message)
      onUpdated()
    } catch (e) {
      toast.error("下载失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const failed = file.status === "failed"
  return <CellButton icon={HardDriveDownload} label="下载" title="下载到服务器" onClick={handleDownload} busy={busy} error={failed ? file.error : undefined} />
}

/** 自己桶列：排队→黄字 / 上传中→进度 / 已存在→绿字+下载 / 有本地→上传按钮。 */
function CloudCell({ file, onUpdated }: { file: FileItem; onUpdated: () => void }) {
  const { jobs } = useJobs()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const job = file.job_id ? jobs[file.job_id] : undefined
  const isMyJob = job && job.kind === "upload"

  if (isMyJob && job!.status === "queued") return <QueuedLabel file={file} />
  if (isMyJob && job!.status === "uploading") return (
    <div className="flex items-center gap-0.5">
      <JobProgressBadge file={file} />
      <CancelJobBtn file={file} />
    </div>
  )

  const failed = file.status === "failed" && !!file.local_path && !file.uploaded

  if (file.uploaded === 1) {
    return (
      <div className="flex flex-col items-center gap-0.5">
        <StatusText tone="active">已存在</StatusText>
        <IconBtn icon={Download} title="下载(自己桶)" href={downloadUrl(file.object_key)} />
      </div>
    )
  }

  if (file.local_path) {
    return (
      <>
        <CellButton
          icon={CloudUpload}
          label="上传"
          title="上传到自己桶"
          onClick={() => setDialogOpen(true)}
          error={failed ? file.error : undefined}
        />
        {dialogOpen && (
          <UploadKeyDialog
            file={file}
            bucket="self"
            onClose={() => setDialogOpen(false)}
            onDone={() => {
              setDialogOpen(false)
              onUpdated()
            }}
          />
        )}
      </>
    )
  }

  return <StatusText error={failed ? file.error : undefined}>待上传</StatusText>
}

/** 北京桶列：与 CloudCell 对称，读 uploaded_beijing，检测 upload_beijing 任务。 */
function BeijingCell({ file, onUpdated }: { file: FileItem; onUpdated: () => void }) {
  const { jobs } = useJobs()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const job = file.job_id ? jobs[file.job_id] : undefined
  const isMyJob = job && job.kind === "upload_beijing"

  if (isMyJob && job!.status === "queued") return <QueuedLabel file={file} />
  if (isMyJob && job!.status === "uploading") return (
    <div className="flex items-center gap-0.5">
      <JobProgressBadge file={file} />
      <CancelJobBtn file={file} />
    </div>
  )

  const failed = file.status === "failed" && !!file.local_path && !file.uploaded_beijing

  if (file.uploaded_beijing === 1) {
    return (
      <div className="flex flex-col items-center gap-0.5">
        <StatusText tone="active">已存在</StatusText>
        <IconBtn icon={Download} title="下载(北京桶)" href={downloadUrl(file.object_key, "beijing")} />
      </div>
    )
  }

  if (file.local_path) {
    return (
      <>
        <CellButton
          icon={CloudUpload}
          label="上传"
          title="上传到北京桶"
          onClick={() => setDialogOpen(true)}
          error={failed ? file.error : undefined}
        />
        {dialogOpen && (
          <UploadKeyDialog
            file={file}
            bucket="beijing"
            onClose={() => setDialogOpen(false)}
            onDone={() => {
              setDialogOpen(false)
              onUpdated()
            }}
          />
        )}
      </>
    )
  }

  return <StatusText error={failed ? file.error : undefined}>待上传</StatusText>
}

export function FilesDataTable({
  data,
  scripts,
  total,
  page,
  pageSize,
  loading,
  beijingEnabled,
  onPageChange,
  onDeleted,
}: FilesDataTableProps) {
  const datasourceName = React.useMemo(() => {
    const map = new Map<number, string>()
    scripts.forEach((s) => map.set(s.id, s.name))
    return map
  }, [scripts])

  const [rowSelection, setRowSelection] = React.useState<Record<string, boolean>>({})
  const [editingFile, setEditingFile] = React.useState<FileItem | null>(null)

  const columns = React.useMemo<ColumnDef<FileItem>[]>(
    () => {
      const cols: ColumnDef<FileItem>[] = [
        {
          id: "select",
          header: ({ table }) => (
            <Checkbox
              checked={table.getIsAllPageRowsSelected()}
              indeterminate={table.getIsSomePageRowsSelected()}
              onCheckedChange={(v) => table.toggleAllPageRowsSelected(v)}
              aria-label="全选"
            />
          ),
          cell: ({ row }) => (
            <Checkbox
              checked={row.getIsSelected()}
              onCheckedChange={(v) => row.toggleSelected(v)}
              aria-label="选择"
            />
          ),
        },
        {
          accessorKey: "datasource_id",
          header: "数据源",
          cell: ({ row }) => {
            const name = row.original.datasource_id
              ? datasourceName.get(row.original.datasource_id)
              : null
            return <Truncate value={name ?? null} className="text-xs" />
          },
        },
        {
          accessorKey: "filename",
          header: "文件名称",
          cell: ({ row }) => {
            const f = row.original
            if (!f.source_url) {
              return <Truncate value={f.filename} />
            }
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="block max-w-[28rem] truncate cursor-default">
                    {f.filename}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm break-all font-mono text-xs">
                  {f.source_url}
                </TooltipContent>
              </Tooltip>
            )
          },
        },
        {
          accessorKey: "size",
          header: () => <div className="min-w-[5rem] text-center">大小</div>,
          cell: ({ row }) => (
            <div className="text-center tabular-nums text-muted-foreground">
              {formatBytes(row.original.size)}
            </div>
          ),
        },
        {
          id: "local",
          header: () => <div className="min-w-[4rem] text-center">本地</div>,
          cell: ({ row }) => <div className="flex justify-center"><LocalCell file={row.original} onUpdated={onDeleted} /></div>,
        },
        {
          id: "cloud",
          header: () => <div className="min-w-[4rem] text-center">自己桶</div>,
          cell: ({ row }) => <div className="flex justify-center"><CloudCell file={row.original} onUpdated={onDeleted} /></div>,
        },
      ]
      if (beijingEnabled) {
        cols.push({
          id: "beijing",
          header: () => <div className="min-w-[4rem] text-center">北京桶</div>,
          cell: ({ row }) => <div className="flex justify-center"><BeijingCell file={row.original} onUpdated={onDeleted} /></div>,
        })
      }
      cols.push(
        {
          id: "actions",
          header: () => <div className="text-center">操作</div>,
          cell: ({ row }) => <RowActions file={row.original} onDeleted={onDeleted} onEdit={() => setEditingFile(row.original)} />,
        },
        {
          accessorKey: "created_at",
          header: () => <div className="text-left">创建时间</div>,
          cell: ({ row }) => (
            <span className="whitespace-nowrap text-muted-foreground">
              {formatTime(row.original.created_at)}
            </span>
          ),
        },
      )
      return cols
    },
    [datasourceName, onDeleted, beijingEnabled],
  )

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: true,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    getRowId: (row) => String(row.id),
    enableRowSelection: true,
    onRowSelectionChange: setRowSelection,
    state: { pagination: { pageIndex: page - 1, pageSize }, rowSelection },
  })

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const selectedFiles = table.getSelectedRowModel().rows.map((r) => r.original)
  const downloadable = selectedFiles.filter((f) => !f.local_path)
  const uploadable = selectedFiles.filter((f) => f.local_path && f.uploaded === 0)
  const beijingUploadable = selectedFiles.filter((f) => f.local_path && f.uploaded_beijing === 0)

  const [batchBusy, setBatchBusy] = React.useState(false)

  const batchDownload = async () => {
    if (!downloadable.length) {
      toast("选中的文件都已在服务器上")
      return
    }
    setBatchBusy(true)
    const results = await Promise.allSettled(downloadable.map((f) => downloadServer(f.id)))
    const ok = results.filter((r) => r.status === "fulfilled").length
    toast.success(`已入队 ${ok} 个下载任务`)
    setRowSelection({})
    setBatchBusy(false)
    onDeleted()
  }

  const batchUpload = async () => {
    if (!uploadable.length) {
      toast("没有可上传的文件（需先下载到服务器）")
      return
    }
    setBatchBusy(true)
    const results = await Promise.allSettled(uploadable.map((f) => uploadToCloud(f.id)))
    const ok = results.filter((r) => r.status === "fulfilled").length
    toast.success(`已入队 ${ok} 个上传任务`)
    setRowSelection({})
    setBatchBusy(false)
    onDeleted()
  }

  const batchUploadBeijing = async () => {
    if (!beijingUploadable.length) {
      toast("没有可上传的文件（需先下载到服务器）")
      return
    }
    setBatchBusy(true)
    const results = await Promise.allSettled(beijingUploadable.map((f) => uploadToBeijing(f.id)))
    const ok = results.filter((r) => r.status === "fulfilled").length
    toast.success(`已入队 ${ok} 个上传任务`)
    setRowSelection({})
    setBatchBusy(false)
    onDeleted()
  }

  const skelWidths = skeletonWidths(beijingEnabled)

  return (
    <div className="space-y-3">
      {/* 批量操作栏 */}
      {selectedFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-4 py-2">
          <span className="text-sm font-medium">已选 {selectedFiles.length} 项</span>
          <Button size="sm" variant="outline" onClick={batchDownload} disabled={batchBusy}>
            <HardDriveDownload className="size-3.5" />
            批量下载到服务器{downloadable.length > 0 && `（${downloadable.length}）`}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={batchUpload}
            disabled={batchBusy || uploadable.length === 0}
            title={uploadable.length === 0 ? "需先下载到服务器" : undefined}
          >
            <CloudUpload className="size-3.5" />
            批量上传到自己桶{uploadable.length > 0 && `（${uploadable.length}）`}
          </Button>
          {beijingEnabled && (
            <Button
              size="sm"
              variant="outline"
              onClick={batchUploadBeijing}
              disabled={batchBusy || beijingUploadable.length === 0}
              title={beijingUploadable.length === 0 ? "需先下载到服务器" : undefined}
            >
              <CloudUpload className="size-3.5" />
              批量上传到北京桶{beijingUploadable.length > 0 && `（${beijingUploadable.length}）`}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setRowSelection({})} disabled={batchBusy}>
            取消选择
          </Button>
        </div>
      )}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={`skeleton-${i}`} className="hover:bg-transparent">
                  {columns.map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton
                        className={cn(
                          "h-4",
                          skelWidths[j] ?? "w-20",
                          j === 3 && "mx-auto", // 大小列居中
                        )}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">
                  文件库还没有文件，录入链接或上传后自动登记。
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 分页 */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          共 <span className="font-medium text-foreground">{total}</span> 条 ·
          第 {page} / {pageCount} 页
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            <ChevronLeft className="size-4" /> 上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= pageCount}
          >
            下一页 <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {editingFile && (
        <EditFileDialog
          file={editingFile}
          scripts={scripts}
          onClose={() => setEditingFile(null)}
          onSaved={() => {
            setEditingFile(null)
            onDeleted()
          }}
        />
      )}
    </div>
  )
}

function RowActions({ file, onDeleted, onEdit }: { file: FileItem; onDeleted: () => void; onEdit: () => void }) {
  const [busy, setBusy] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const handleDelete = async () => {
    setBusy(true)
    try {
      await deleteFile(file.id)
      toast.success("已删除")
      setDeleteOpen(false)
      onDeleted()
    } catch (e) {
      toast.error("删除失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-center gap-1">
      <Button variant="ghost" size="sm" onClick={onEdit} title="编辑">
        <Pencil className="size-3.5" /> 编辑
      </Button>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            title="删除"
          >
            <Trash2 className="size-3.5" /> 删除
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除？</AlertDialogTitle>
            <AlertDialogDescription>
              确认删除「{file.filename || file.object_key}」？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={busy}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {busy ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 编辑文件记录 Modal。 */
function EditFileDialog({
  file,
  scripts,
  onClose,
  onSaved,
}: {
  file: FileItem
  scripts: Datasource[]
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = React.useState({
    filename: file.filename ?? "",
    object_key: file.object_key,
    md5: file.md5 ?? "",
    size: String(file.size),
    bucket: file.bucket ?? "",
    source_url: file.source_url ?? "",
    local_path: file.local_path ?? "",
    uploaded: file.uploaded === 1,
    uploaded_beijing: file.uploaded_beijing === 1,
    status: file.status,
    datasource_id: file.datasource_id ? String(file.datasource_id) : "",
    error: file.error ?? "",
  })
  const [busy, setBusy] = React.useState(false)

  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
    setBusy(true)
    try {
      await updateFile(file.id, {
        filename: form.filename || null,
        object_key: form.object_key,
        md5: form.md5 || null,
        size: Number(form.size) || 0,
        bucket: form.bucket,
        source_url: form.source_url || null,
        local_path: form.local_path || null,
        uploaded: form.uploaded,
        uploaded_beijing: form.uploaded_beijing,
        status: form.status,
        datasource_id: form.datasource_id ? Number(form.datasource_id) : null,
        error: form.error || null,
      })
      toast.success("已保存")
      onSaved()
    } catch (e) {
      toast.error("保存失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>编辑文件记录</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-4 overflow-y-auto py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-filename">文件名</Label>
              <Input
                id="edit-filename"
                value={form.filename}
                onChange={(e) => set("filename", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-object-key">Object Key</Label>
              <Input
                id="edit-object-key"
                value={form.object_key}
                onChange={(e) => set("object_key", e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-md5">MD5</Label>
              <Input
                id="edit-md5"
                value={form.md5}
                onChange={(e) => set("md5", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-size">大小（字节）</Label>
              <Input
                id="edit-size"
                type="number"
                value={form.size}
                onChange={(e) => set("size", e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-bucket">Bucket</Label>
              <Input
                id="edit-bucket"
                value={form.bucket}
                onChange={(e) => set("bucket", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-source-url">来源链接</Label>
              <Input
                id="edit-source-url"
                value={form.source_url}
                onChange={(e) => set("source_url", e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-local-path">本地路径</Label>
              <Input
                id="edit-local-path"
                value={form.local_path}
                onChange={(e) => set("local_path", e.target.value)}
                placeholder="（空 = 不存在）"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-error">错误信息</Label>
              <Input
                id="edit-error"
                value={form.error}
                onChange={(e) => set("error", e.target.value)}
                placeholder="（空 = 无）"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>状态</Label>
              <Select value={form.status} onValueChange={(v) => set("status", v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">pending</SelectItem>
                  <SelectItem value="synced">synced</SelectItem>
                  <SelectItem value="failed">failed</SelectItem>
                  <SelectItem value="deleted">deleted</SelectItem>
                  <SelectItem value="cancelled">cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>数据源</Label>
              <Select value={form.datasource_id} onValueChange={(v) => set("datasource_id", v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="不关联" />
                </SelectTrigger>
                <SelectContent>
                  {scripts.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={form.uploaded}
                onCheckedChange={(v) => set("uploaded", v === true)}
              />
              自己桶已上传
            </label>
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={form.uploaded_beijing}
                onCheckedChange={(v) => set("uploaded_beijing", v === true)}
              />
              北京桶已上传
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
