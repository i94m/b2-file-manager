import * as React from "react"
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ChevronLeft, ChevronRight, Download, HardDriveDownload, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { type Datasource, type FileItem } from "@/lib/types"
import { cn, formatBytes, formatTime } from "@/lib/utils"
import { deleteObject, downloadServer, downloadUrl, triggerUpload } from "@/lib/api"
import { ProgressCell } from "@/components/progress-cell"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"

/** 骨架行各列的宽度类（按 columns 顺序对齐，模拟真实数据宽度）。 */
const SKELETON_WIDTHS = [
  "w-32",   // 对象名 (UUID)
  "w-28",   // 原始名称
  "w-40",   // MD5
  "w-16",   // 大小（右对齐）
  "w-16",   // Bucket
  "w-14",   // 状态
  "w-16",   // 脚本
  "w-32",   // 来源
  "w-24",   // 创建时间
  "w-8",    // 操作
]
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

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

  const columns = React.useMemo<ColumnDef<FileItem>[]>(
    () => [
      {
        accessorKey: "object_key",
        header: "对象名 (UUID)",
        cell: ({ row }) => (
          <Truncate
            value={row.original.object_key}
            className="font-mono text-xs text-muted-foreground"
          />
        ),
      },
      {
        accessorKey: "filename",
        header: "原始名称",
        cell: ({ row }) => <Truncate value={row.original.filename} />,
      },
      {
        accessorKey: "md5",
        header: "MD5",
        cell: ({ row }) => (
          <Truncate value={row.original.md5} className="font-mono text-[11px] text-muted-foreground" />
        ),
      },
      {
        accessorKey: "size",
        header: () => <div className="text-right">大小</div>,
        cell: ({ row }) => (
          <div className="text-right tabular-nums text-muted-foreground">
            {formatBytes(row.original.size)}
          </div>
        ),
      },
      {
        accessorKey: "bucket",
        header: "Bucket",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.bucket || "—"}
          </span>
        ),
      },
      {
        id: "status",
        header: "状态",
        cell: ({ row }) => <ProgressCell file={row.original} />,
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
        accessorKey: "source_url",
        header: "来源",
        cell: ({ row }) => (
          <Truncate
            value={row.original.source_url}
            className="font-mono text-xs text-muted-foreground"
          />
        ),
      },
      {
        accessorKey: "created_at",
        header: "创建时间",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {formatTime(row.original.created_at)}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <div className="text-right">操作</div>,
        cell: ({ row }) => <RowActions file={row.original} onDeleted={onDeleted} />,
      },
    ],
    [datasourceName, onDeleted],
  )

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: true, // 后端分页
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    state: { pagination: { pageIndex: page - 1, pageSize } },
  })

  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-3">
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
                          j === 3 && "ml-auto", // 大小列右对齐
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

  const handleUpload = async () => {
    setBusy(true)
    try {
      const r = await triggerUpload(file.id)
      toast.success(r.message)
      onDeleted()
    } catch (e) {
      toast.error("上传失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

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

  const handleDelete = async () => {
    if (!confirm(`确认删除对象 ${file.object_key}？此操作不可撤销。`)) return
    setBusy(true)
    try {
      await deleteObject(file.object_key)
      toast.success("已删除", { description: file.object_key })
      onDeleted()
    } catch (e) {
      toast.error("删除失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {file.uploaded === 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleUpload}
          disabled={busy}
          title="上传到 Bucket"
        >
          <Upload className="size-3.5" /> 上传
        </Button>
      )}
      {file.uploaded === 1 && !file.local_path && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDownloadServer}
          disabled={busy}
          title="下载到服务器 SERVER_FILE_ROOT"
        >
          <HardDriveDownload className="size-3.5" /> 下载到服务器
        </Button>
      )}
      <Button asChild variant="ghost" size="sm" title="下载">
        <a href={downloadUrl(file.object_key)}>
          <Download className="size-3.5" /> 下载
        </a>
      </Button>
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
