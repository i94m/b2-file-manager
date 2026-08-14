import * as React from "react"
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ChevronLeft, ChevronRight, CloudUpload, Download, HardDriveDownload, ListOrdered, Loader2, MoreVertical, Pause, Pencil, Play, RefreshCw, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { type BucketInfo, type Datasource, type FileItem } from "@/lib/types"
import { cn, formatBytes, formatTime } from "@/lib/utils"
import {
  cancelJob,
  checkFileExists,
  deleteFile,
  downloadServerFromBucket,
  getFile,
  pauseJob,
  resumeJob,
  updateFile,
  uploadFileToBucket,
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
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { CopyButton } from "@/components/ui/copy-button"

/** 骨架行各列的宽度类（按 columns 顺序对齐，模拟真实数据宽度）。 */
function skeletonWidths(bucketCount: number): string[] {
  const widths = [
    "w-4",    // select
    "w-16",   // 数据源
    "w-28",   // 文件名称
    "w-20",   // 大小（居中）
    "w-16",   // 本地
  ]
  for (let i = 0; i < bucketCount; i++) widths.push("w-16") // 各桶列
  widths.push("w-24", "w-8") // 创建时间、操作
  return widths
}

interface FilesDataTableProps {
  data: FileItem[]
  scripts: Datasource[]
  /** 全部桶（含禁用；顺序：默认优先 → sort_order → id），列按此动态生成。 */
  buckets: BucketInfo[]
  total: number
  page: number
  pageSize: number
  loading: boolean
  onPageChange: (page: number) => void
  onDeleted: () => void
  onFileUpdated?: (file: FileItem) => void
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

/** 检测中状态：重新检测在 ⋮ 菜单里触发，菜单随即关闭，需在单元格内展示 loading。 */
function CheckingText() {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      检测中…
    </span>
  )
}

/** 单元格内「更多操作」⋮ 菜单（一格有多个操作时收敛于此）。 */
function CellMenu({
  items,
}: {
  items: Array<{
    icon: React.ComponentType<{ className?: string }>
    label: string
    onClick: () => void
    busy?: boolean
    destructive?: boolean
  }>
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="更多操作"
          className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <MoreVertical className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {items.map((it) => (
          <DropdownMenuItem
            key={it.label}
            onClick={it.onClick}
            disabled={it.busy}
            variant={it.destructive ? "destructive" : "default"}
          >
            {it.busy ? <Loader2 className="size-3.5 animate-spin" /> : <it.icon className="size-3.5" />}
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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

/** 小型任务操作按钮组：暂停/恢复 + 取消（排队 / 上传中均可点击）。 */
function CancelJobBtn({ file }: { file: FileItem }) {
  const { jobs } = useJobs()
  const [busy, setBusy] = React.useState(false)
  const [confirm, confirmDialog] = useConfirm()
  const job = file.job_id ? jobs[file.job_id] : undefined
  if (!job) return null

  const handlePauseResume = async () => {
    setBusy(true)
    try {
      const r = job.paused ? await resumeJob(job.id) : await pauseJob(job.id)
      toast(r.message)
    } catch (e) {
      toast.error("操作失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const handleCancel = async () => {
    if (!await confirm({
      title: "取消任务",
      description: `确认取消任务「${job.filename}」？`,
      confirmText: "取消任务",
      destructive: true,
    })) return
    setBusy(true)
    try {
      const r = await cancelJob(job.id)
      toast(r.message)
    } catch (e) {
      toast.error("取消失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const btnClass = "inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={btnClass} title="任务操作">
            <MoreVertical className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={handlePauseResume} disabled={busy}>
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : job.paused ? (
              <Play className="size-3.5" />
            ) : (
              <Pause className="size-3.5" />
            )}
            {job.paused ? "继续" : "暂停"}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={handleCancel} disabled={busy}>
            <X className="size-3.5" />
            取消任务
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmDialog}
    </>
  )
}

/** 重新检测存在性的逻辑（独立按钮与「更多操作」菜单项共用）。 */
function useCheckExist(
  fileId: number,
  target: "local" | number,
  onFileUpdated?: (file: FileItem) => void,
) {
  const [busy, setBusy] = React.useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const r = await checkFileExists(fileId, target)
      if (r.exists) {
        toast.success("文件存在")
      } else {
        toast("文件不存在，已更新状态", { description: "可重新下载或上传" })
      }
      if (r.file && onFileUpdated) {
        onFileUpdated(r.file)
      }
    } catch (e) {
      toast.error("检测失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

/** 重新检测文件是否存在的图标按钮（本地 / 任意桶通用；共用单元格的检测状态，检测中时状态文字同步切换）。 */
function CheckExistBtn({ check }: { check: ReturnType<typeof useCheckExist> }) {
  return (
    <button
      type="button"
      onClick={check.run}
      disabled={check.busy}
      className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      title="重新检测"
    >
      {check.busy ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
    </button>
  )
}

/** 排队中黄字 + 取消按钮；串行（排队执行）任务显示「排队中（串行）」。 */
function QueuedLabel({ file }: { file: FileItem }) {
  const { jobs } = useJobs()
  const job = file.job_id ? jobs[file.job_id] : undefined
  return (
    <div className="flex items-center gap-0.5">
      <StatusText tone="queued">{job?.serial ? "排队中（串行）" : "排队中"}</StatusText>
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
  bucketId,
  bucketLabel,
  onClose,
  onDone,
}: {
  file: FileItem
  bucketId: number
  bucketLabel: string
  onClose: () => void
  onDone: () => void
}) {
  const [history] = React.useState(() => loadDirHistory())
  const [dir, setDir] = React.useState(history[0] ?? "")
  const [filename, setFilename] = React.useState(file.filename ?? "")
  const [serial, setSerial] = React.useState(false)
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
      const r = await uploadFileToBucket(file.id, bucketId, key, { serial })
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
          <DialogTitle>上传到{bucketLabel}</DialogTitle>
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
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={serial}
              onCheckedChange={(v) => setSerial(v === true)}
              aria-label="排队执行"
            />
            排队执行（与其他排队任务按顺序逐个传输）
          </label>
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

/** 行级刷新：只拉取本行最新数据并 patch，不刷新整表（无 onFileUpdated 时回退整表刷新）。 */
function refreshFileRow(
  fileId: number,
  onUpdated: () => void,
  onFileUpdated?: (file: FileItem) => void,
) {
  if (onFileUpdated) {
    getFile(fileId).then(onFileUpdated).catch((e) => console.error(e))
  } else {
    onUpdated()
  }
}

/** 本地列：排队→黄字 / 传输中→进度 / 已存在→绿字 / 否则→未下载+菜单。 */
function LocalCell({ file, onUpdated, onFileUpdated }: { file: FileItem; onUpdated: () => void; onFileUpdated?: (file: FileItem) => void }) {
  const { jobs } = useJobs()
  const [busy, setBusy] = React.useState(false)
  const check = useCheckExist(file.id, "local", onFileUpdated)
  const job = file.job_id ? jobs[file.job_id] : undefined
  const isMyJob = job && (job.kind === "fetch" || job.kind === "download")

  if (isMyJob && job!.status === "queued") return <QueuedLabel file={file} />
  if (isMyJob && job!.status === "uploading") return (
    <div className="flex items-center gap-0.5">
      <JobProgressBadge file={file} />
      <CancelJobBtn file={file} />
    </div>
  )

  if (file.local_path) return (
    <div className="flex items-center gap-0.5">
      {check.busy ? <CheckingText /> : <StatusText tone="active">已存在</StatusText>}
      <CheckExistBtn check={check} />
    </div>
  )

  const handleDownload = async (serial = false) => {
    setBusy(true)
    try {
      const r = await downloadServerFromBucket(file.id, undefined, { serial })
      toast.success(r.message)
      refreshFileRow(file.id, onUpdated, onFileUpdated)
    } catch (e) {
      toast.error("下载失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const failed = file.status === "failed"
  return (
    <div className="flex items-center gap-0.5">
      {check.busy ? (
        <CheckingText />
      ) : (
        <StatusText error={failed ? file.error : undefined}>未下载</StatusText>
      )}
      <CellMenu
        items={[
          { icon: HardDriveDownload, label: "立即下载", onClick: () => handleDownload(), busy },
          { icon: ListOrdered, label: "排队下载", onClick: () => handleDownload(true), busy },
          { icon: RefreshCw, label: "重新检测", onClick: check.run, busy: check.busy },
        ]}
      />
    </div>
  )
}

/** 桶列（通用）：排队→黄字 / 上传中→进度 / 已存在→绿字+菜单 / 有本地→未上传+菜单。 */
function BucketCell({ file, bucket, onUpdated, onFileUpdated }: { file: FileItem; bucket: BucketInfo; onUpdated: () => void; onFileUpdated?: (file: FileItem) => void }) {
  const { jobs } = useJobs()
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [downloading, setDownloading] = React.useState(false)
  const check = useCheckExist(file.id, bucket.id, onFileUpdated)
  const job = file.job_id ? jobs[file.job_id] : undefined
  const uploaded = file.uploaded_bucket_ids.includes(bucket.id)
  const isMyJob = job && job.kind === "upload" && job.bucket_id === bucket.id

  if (isMyJob && job!.status === "queued") return <QueuedLabel file={file} />
  if (isMyJob && job!.status === "uploading") return (
    <div className="flex items-center gap-0.5">
      <JobProgressBadge file={file} />
      <CancelJobBtn file={file} />
    </div>
  )

  const failed = file.status === "failed" && !!file.local_path && !uploaded

  const handleDownload = async (serial = false) => {
    setDownloading(true)
    try {
      const r = await downloadServerFromBucket(file.id, bucket.id, { serial })
      toast.success(r.message)
      refreshFileRow(file.id, onUpdated, onFileUpdated)
    } catch (e) {
      toast.error("下载失败", { description: (e as Error).message })
    } finally {
      setDownloading(false)
    }
  }

  if (uploaded) {
    return (
      <div className="flex items-center gap-0.5">
        {check.busy ? <CheckingText /> : <StatusText tone="active">已存在</StatusText>}
        <CellMenu
          items={[
            { icon: Download, label: "立即下载", onClick: () => handleDownload(), busy: downloading },
            { icon: ListOrdered, label: "排队下载", onClick: () => handleDownload(true), busy: downloading },
            { icon: RefreshCw, label: "重新检测", onClick: check.run, busy: check.busy },
          ]}
        />
      </div>
    )
  }

  if (file.local_path) {
    return (
      <>
        <div className="flex items-center gap-0.5">
          {check.busy ? (
            <CheckingText />
          ) : (
            <StatusText error={failed ? file.error : undefined}>未上传</StatusText>
          )}
          <CellMenu
            items={[
              { icon: CloudUpload, label: "上传", onClick: () => setDialogOpen(true) },
              { icon: RefreshCw, label: "重新检测", onClick: check.run, busy: check.busy },
            ]}
          />
        </div>
        {dialogOpen && (
          <UploadKeyDialog
            file={file}
            bucketId={bucket.id}
            bucketLabel={bucket.name}
            onClose={() => setDialogOpen(false)}
            onDone={() => {
              setDialogOpen(false)
              refreshFileRow(file.id, onUpdated, onFileUpdated)
            }}
          />
        )}
      </>
    )
  }

  return (
    <div className="flex items-center gap-0.5">
      {check.busy ? (
        <CheckingText />
      ) : (
        <StatusText error={failed ? file.error : undefined}>待上传</StatusText>
      )}
      <CheckExistBtn check={check} />
    </div>
  )
}

export function FilesDataTable({
  data,
  scripts,
  buckets,
  total,
  page,
  pageSize,
  loading,
  onPageChange,
  onDeleted,
  onFileUpdated,
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
            if (!f.filename) {
              return <Truncate value={f.filename} />
            }
            return (
              <div className="flex items-center gap-1">
                {f.source_url ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block max-w-[26rem] truncate cursor-default">
                        {f.filename}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm break-all font-mono text-xs">
                      {f.source_url}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Truncate value={f.filename} />
                )}
                <CopyButton
                  value={f.filename}
                  title="复制文件名"
                  className="size-5 p-0.5 hover:bg-muted"
                />
              </div>
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
          cell: ({ row }) => <div className="flex justify-center"><LocalCell file={row.original} onUpdated={onDeleted} onFileUpdated={onFileUpdated} /></div>,
        },
      ]
      buckets.forEach((bucket) => {
        cols.push({
          id: `bucket-${bucket.id}`,
          header: () => <div className="min-w-[4rem] text-center">{bucket.name}</div>,
          cell: ({ row }) => <div className="flex justify-center"><BucketCell file={row.original} bucket={bucket} onUpdated={onDeleted} onFileUpdated={onFileUpdated} /></div>,
        })
      })
      cols.push(
        {
          accessorKey: "created_at",
          header: () => <div className="text-left">创建时间</div>,
          cell: ({ row }) => (
            <span className="whitespace-nowrap text-muted-foreground">
              {formatTime(row.original.created_at)}
            </span>
          ),
        },
        {
          id: "actions",
          header: () => <div className="text-center">操作</div>,
          cell: ({ row }) => <RowActions file={row.original} onDeleted={onDeleted} onEdit={() => setEditingFile(row.original)} />,
        },
      )
      return cols
    },
    [datasourceName, onDeleted, onFileUpdated, buckets],
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
  /** 每个桶可批量上传的文件（有本地副本且尚未上传到该桶）。 */
  const uploadableByBucket = new Map<number, FileItem[]>()
  buckets.forEach((b) => {
    uploadableByBucket.set(
      b.id,
      selectedFiles.filter((f) => f.local_path && !f.uploaded_bucket_ids.includes(b.id)),
    )
  })

  const [batchBusy, setBatchBusy] = React.useState(false)
  const [batchSerial, setBatchSerial] = React.useState(false)

  const batchDownload = async () => {
    if (!downloadable.length) {
      toast("选中的文件都已在服务器上")
      return
    }
    setBatchBusy(true)
    const results = await Promise.allSettled(
      downloadable.map((f) => downloadServerFromBucket(f.id, undefined, { serial: batchSerial })),
    )
    const ok = results.filter((r) => r.status === "fulfilled").length
    toast.success(`已入队 ${ok} 个下载任务${batchSerial ? "（串行执行）" : ""}`)
    setRowSelection({})
    setBatchBusy(false)
    // 行级更新：只刷新受影响的行
    downloadable.forEach((f) => refreshFileRow(f.id, onDeleted, onFileUpdated))
  }

  const batchUploadTo = async (bucket: BucketInfo) => {
    const uploadable = uploadableByBucket.get(bucket.id) ?? []
    if (!uploadable.length) {
      toast("没有可上传的文件（需先下载到服务器）")
      return
    }
    setBatchBusy(true)
    const results = await Promise.allSettled(
      uploadable.map((f) => uploadFileToBucket(f.id, bucket.id, undefined, { serial: batchSerial })),
    )
    const ok = results.filter((r) => r.status === "fulfilled").length
    toast.success(`已入队 ${ok} 个上传任务${batchSerial ? "（串行执行）" : ""}`)
    setRowSelection({})
    setBatchBusy(false)
    // 行级更新：只刷新受影响的行
    uploadable.forEach((f) => refreshFileRow(f.id, onDeleted, onFileUpdated))
  }

  const skelWidths = skeletonWidths(buckets.length)

  return (
    <div className="space-y-3">
      {/* 批量操作栏 */}
      {selectedFiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-4 py-2">
          <span className="text-sm font-medium">已选 {selectedFiles.length} 项</span>
          <label
            className="flex cursor-pointer items-center gap-1.5 text-sm text-muted-foreground"
            title="排队任务之间严格按提交顺序逐个传输，可与正在执行的并行任务同时进行"
          >
            <Checkbox
              checked={batchSerial}
              onCheckedChange={(v) => setBatchSerial(v === true)}
              aria-label="排队执行"
            />
            排队执行
          </label>
          <Button size="sm" variant="outline" onClick={batchDownload} disabled={batchBusy}>
            <HardDriveDownload className="size-3.5" />
            批量下载到服务器{downloadable.length > 0 && `（${downloadable.length}）`}{batchSerial && "（排队）"}
          </Button>
          {buckets.map((bucket) => {
            const uploadable = uploadableByBucket.get(bucket.id) ?? []
            return (
              <Button
                key={bucket.id}
                size="sm"
                variant="outline"
                onClick={() => batchUploadTo(bucket)}
                disabled={batchBusy || uploadable.length === 0}
                title={uploadable.length === 0 ? "需先下载到服务器" : undefined}
              >
                <CloudUpload className="size-3.5" />
                批量上传到{bucket.name}{uploadable.length > 0 && `（${uploadable.length}）`}{batchSerial && "（排队）"}
              </Button>
            )
          })}
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
                  <TableHead
                    key={header.id}
                    className={
                      header.column.id === "actions"
                        ? "sticky right-0 z-10 bg-background shadow-[-1px_0_0_0_var(--border)]"
                        : undefined
                    }
                  >
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
                <TableRow key={row.id} className="group">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={
                        cell.column.id === "actions"
                          ? "sticky right-0 z-10 bg-background group-hover:bg-muted/50 shadow-[-1px_0_0_0_var(--border)]"
                          : undefined
                      }
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">
                  文件库还没有文件，录入待处理文件或上传后自动登记。
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
            const edited = editingFile
            setEditingFile(null)
            refreshFileRow(edited.id, onDeleted, onFileUpdated)
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
    <div className="flex items-center justify-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="更多操作"
            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <MoreVertical className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="size-3.5" /> 编辑
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="size-3.5" /> 删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
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

/** 编辑文件记录 Modal（仅基础信息；其余字段由列表内操作维护）。 */
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
    size: String(file.size),
    status: file.status,
    datasource_id: file.datasource_id ? String(file.datasource_id) : "",
  })
  const [busy, setBusy] = React.useState(false)

  const set = (key: keyof typeof form, value: string) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = async () => {
    setBusy(true)
    try {
      await updateFile(file.id, {
        filename: form.filename || null,
        size: Number(form.size) || 0,
        status: form.status,
        datasource_id: form.datasource_id ? Number(form.datasource_id) : null,
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑文件记录</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
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
