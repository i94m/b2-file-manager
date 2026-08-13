import * as React from "react"
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ChevronLeft, ChevronRight, CloudUpload, Download, HardDriveDownload, Loader2, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { type Datasource, type FileItem } from "@/lib/types"
import { cn, formatBytes, formatTime } from "@/lib/utils"
import { deleteFile, downloadServer, downloadUrl, updateFile, uploadToCloud } from "@/lib/api"
import { useJobs } from "@/lib/use-jobs"
import { JobProgressBadge } from "@/components/progress-cell"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
const SKELETON_WIDTHS = [
  "w-4",    // select
  "w-16",   // 数据源
  "w-28",   // 文件名称
  "w-20",   // 大小（居中）
  "w-16",   // 本地
  "w-16",   // 云存储
  "w-8",    // 操作
  "w-24",   // 创建时间
]

interface FilesDataTableProps {
  data: FileItem[]
  scripts: Datasource[]
  total: number
  page: number
  pageSize: number
  loading: boolean
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

/** 本地 / 云存储 存在状态：绿色"已存在" / 红色"不存在"。
 *  传入 onToggle 时变为可点击按钮（hover 提示"点击切换状态"）。 */
function PresenceLabel({
  active,
  error,
  onToggle,
  busy,
}: {
  active: boolean
  error?: string | null
  onToggle?: () => void
  busy?: boolean
}) {
  const label = active ? "已存在" : "不存在"
  const color = active ? "text-emerald-600" : "text-red-500"

  if (onToggle) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            disabled={busy}
            className="inline-flex items-center rounded px-1 py-0.5 transition-colors hover:bg-accent disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
            ) : (
              <span className={cn("text-xs font-medium", color)}>{label}</span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-all">
          {!active && error ? error : "点击切换状态"}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (!active && error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("cursor-help text-xs font-medium", color)}>{label}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-all">{error}</TooltipContent>
      </Tooltip>
    )
  }
  return <span className={cn("text-xs font-medium", color)}>{label}</span>
}

/** 本地列：正在下载/抓取时显示进度，否则显示可点击的存在状态。 */
function LocalCell({ file, onUpdated }: { file: FileItem; onUpdated: () => void }) {
  const { jobs } = useJobs()
  const [busy, setBusy] = React.useState(false)
  const job = file.job_id ? jobs[file.job_id] : undefined
  const active = job && (job.status === "uploading" || job.status === "queued") &&
    (job.kind === "fetch" || job.kind === "download")
  if (active) return <JobProgressBadge file={file} />

  const handleToggle = async () => {
    setBusy(true)
    try {
      await updateFile(file.id, {
        local_path: file.local_path ? null : file.object_key,
      })
      toast.success(file.local_path ? "已标记为本地不存在" : "已标记为本地已存在")
      onUpdated()
    } catch (e) {
      toast.error("修改失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const failed = file.status === "failed" && !file.local_path
  return (
    <PresenceLabel
      active={!!file.local_path}
      error={failed ? file.error : undefined}
      onToggle={handleToggle}
      busy={busy}
    />
  )
}

/** 云存储列：正在上传时显示进度，否则显示可点击的存在状态。 */
function CloudCell({ file, onUpdated }: { file: FileItem; onUpdated: () => void }) {
  const { jobs } = useJobs()
  const [busy, setBusy] = React.useState(false)
  const job = file.job_id ? jobs[file.job_id] : undefined
  const active = job && (job.status === "uploading" || job.status === "queued") &&
    job.kind === "upload"
  if (active) return <JobProgressBadge file={file} />

  const handleToggle = async () => {
    setBusy(true)
    try {
      await updateFile(file.id, { uploaded: file.uploaded !== 1 })
      toast.success(file.uploaded === 1 ? "已标记为云存储未上传" : "已标记为云存储已上传")
      onUpdated()
    } catch (e) {
      toast.error("修改失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const failed = file.status === "failed" && !!file.local_path && !file.uploaded
  return (
    <PresenceLabel
      active={file.uploaded === 1}
      error={failed ? file.error : undefined}
      onToggle={handleToggle}
      busy={busy}
    />
  )
}

export function FilesDataTable({
  data,
  scripts,
  total,
  page,
  pageSize,
  loading,
  onPageChange,
  onDeleted,
}: FilesDataTableProps) {
  const datasourceName = React.useMemo(() => {
    const map = new Map<number, string>()
    scripts.forEach((s) => map.set(s.id, s.name))
    return map
  }, [scripts])

  const [rowSelection, setRowSelection] = React.useState<Record<string, boolean>>({})

  const columns = React.useMemo<ColumnDef<FileItem>[]>(
    () => [
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
        header: () => <div className="min-w-[4rem] text-center">云存储</div>,
        cell: ({ row }) => <div className="flex justify-center"><CloudCell file={row.original} onUpdated={onDeleted} /></div>,
      },
      {
        id: "actions",
        header: () => <div className="text-center">操作</div>,
        cell: ({ row }) => <RowActions file={row.original} onDeleted={onDeleted} />,
      },
      {
        accessorKey: "created_at",
        header: () => <div className="text-right">创建时间</div>,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {formatTime(row.original.created_at)}
          </span>
        ),
      },
    ],
    [datasourceName, onDeleted],
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
            批量上传到云{uploadable.length > 0 && `（${uploadable.length}）`}
          </Button>
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
                          SKELETON_WIDTHS[j] ?? "w-20",
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
    </div>
  )
}

function RowActions({ file, onDeleted }: { file: FileItem; onDeleted: () => void }) {
  const [busy, setBusy] = React.useState(false)

  const handleDownloadServer = async () => {
    setBusy(true)
    try {
      const r = await downloadServer(file.id)
      toast.success(r.message)
      onDeleted()
    } catch (e) {
      toast.error("下载失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const handleUploadCloud = async () => {
    setBusy(true)
    try {
      const r = await uploadToCloud(file.id)
      toast.success(r.message)
      onDeleted()
    } catch (e) {
      toast.error("上传失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`确认删除「${file.filename || file.object_key}」？此操作不可撤销。`)) return
    setBusy(true)
    try {
      await deleteFile(file.id)
      toast.success("已删除")
      onDeleted()
    } catch (e) {
      toast.error("删除失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-center gap-1">
      {!file.local_path && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDownloadServer}
          disabled={busy}
          title="下载到服务器"
        >
          <HardDriveDownload className="size-3.5" /> 下载到服务器
        </Button>
      )}
      {file.local_path && file.uploaded === 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleUploadCloud}
          disabled={busy}
          title="上传到云"
        >
          <CloudUpload className="size-3.5" /> 上传到云
        </Button>
      )}
      {file.uploaded === 1 && (
        <Button asChild variant="ghost" size="sm" title="下载">
          <a href={downloadUrl(file.object_key)}>
            <Download className="size-3.5" /> 下载
          </a>
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDelete}
        disabled={busy}
        className="text-destructive hover:text-destructive"
        title="删除"
      >
        <Trash2 className="size-3.5" /> 删除
      </Button>
    </div>
  )
}
