import * as React from "react"
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { type Bucket } from "@/lib/api"
import { type FileItem, type JobUpdate } from "@/lib/types"
import { cn, formatBytes, formatTime } from "@/lib/utils"
import { useJobs } from "@/lib/use-jobs"
import { JobProgressBadge } from "@/components/progress-cell"
import { StatusText } from "@/components/status-text"

/** 活跃（排队中/传输中）任务按 object_key 匹配出的行级状态。 */
export interface ActiveFileStatus {
  job: JobUpdate
  /** 本地列（fetch/download）或某桶列（upload）。 */
  target: "local" | number
}
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CopyButton } from "@/components/ui/copy-button"

/**
 * 只读同步状态单元（公开页矩阵核心）：
 * 排队→黄字 / 传输中→进度徽章 / 已同步→绿字 / 否则→灰字（失败 hover 错误）。
 * active 由父级按 object_key 从活跃任务解析（file.job_id 快照滞后时的兜底）。
 */
function ReadOnlySyncCell({
  file,
  target,
  active,
}: {
  file: FileItem
  target: "local" | number
  active?: ActiveFileStatus
}) {
  const { jobs } = useJobs()
  const job = active?.job ?? (file.job_id ? jobs[file.job_id] : undefined)
  const isMyJob = job && (target === "local"
    ? job.kind === "fetch" || job.kind === "download"
    : (job.kind === "upload" || job.kind === "transfer") && job.bucket_id === target)

  if (isMyJob && job.status === "queued") {
    return <StatusText tone="queued">排队中</StatusText>
  }
  if (isMyJob && job.status === "uploading") {
    return <JobProgressBadge file={file} job={job} />
  }

  const synced = target === "local"
    ? !!file.local_path
    : file.uploaded_bucket_ids.includes(target)
  return (
    <StatusText
      tone={synced ? "active" : "muted"}
      error={file.status === "failed" ? file.error : null}
    >
      {synced
        ? target === "local" ? "已存在" : "已同步"
        : target === "local" ? "不存在" : "未同步"}
    </StatusText>
  )
}

/** 骨架行各列的宽度类（按 columns 顺序对齐）。 */
function skeletonWidths(bucketCount: number): string[] {
  const widths = [
    "w-64",   // ObjectKey
    "w-20",   // 大小（居中）
    "w-16",   // 本地
  ]
  for (let i = 0; i < bucketCount; i++) widths.push("w-16") // 各桶列
  widths.push("w-24") // 创建时间
  return widths
}

interface PublicFilesTableProps {
  data: FileItem[]
  /** 全部桶（仅启用桶生成列，与管理页一致）。 */
  buckets: Bucket[]
  /** object_key → 活跃任务状态（正在上传/下载的文件，可能尚未登记为文件记录）。 */
  activeMap?: Map<string, ActiveFileStatus>
  total: number
  page: number
  pageSize: number
  loading: boolean
  onPageChange: (page: number) => void
}

/** 公开页只读表格：文件 × 桶同步状态矩阵（无选择/操作列）。 */
export function PublicFilesTable({
  data,
  buckets,
  activeMap,
  total,
  page,
  pageSize,
  loading,
  onPageChange,
}: PublicFilesTableProps) {
  const enabledBuckets = React.useMemo(
    () => buckets.filter((b) => b.enabled),
    [buckets],
  )

  // 展示行 = 当前页文件记录 ∪ 活跃任务对应的文件（去重：同一 object_key 只保留一条，
  // 文件记录优先——其大小/时间等元数据完整，活跃状态经 activeMap 叠加到单元格）。
  const rows = React.useMemo(() => {
    if (!activeMap || activeMap.size === 0) return data
    const seen = new Set(data.map((f) => f.object_key))
    const extras: FileItem[] = []
    for (const status of activeMap.values()) {
      if (seen.has(status.job.object_key)) continue
      seen.add(status.job.object_key)
      extras.push({
        id: -status.job.id, // 负 job id，避免与真实文件 id 冲突
        job_id: status.job.id,
        object_key: status.job.object_key,
        filename: status.job.filename,
        md5: null,
        size: status.job.size,
        bucket: "",
        source_url: status.job.source,
        uploaded_bucket_ids: [],
        status: "pending",
        datasource_id: null,
        download_kind: null,
        download_bucket_id: null,
        local_path: null,
        created_at: status.job.created_at,
        updated_at: status.job.created_at,
        synced_at: null,
        error: null,
      })
    }
    return extras.length ? [...extras, ...data] : data
  }, [data, activeMap])

  const columns = React.useMemo<ColumnDef<FileItem>[]>(
    () => {
      const cols: ColumnDef<FileItem>[] = [
        {
          accessorKey: "object_key",
          header: "ObjectKey",
          cell: ({ row }) => (
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="block max-w-[11rem] truncate font-mono text-xs sm:max-w-[26rem]">
                    {row.original.object_key}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-sm break-all">
                  {row.original.object_key}
                </TooltipContent>
              </Tooltip>
              <CopyButton
                value={row.original.object_key}
                title="复制 ObjectKey"
                className="size-5 p-0.5 hover:bg-muted"
              />
            </div>
          ),
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
          cell: ({ row }) => (
            <div className="flex justify-center">
              <ReadOnlySyncCell
                file={row.original}
                target="local"
                active={activeMap?.get(row.original.object_key)}
              />
            </div>
          ),
        },
      ]
      enabledBuckets.forEach((bucket) => {
        cols.push({
          id: `bucket-${bucket.id}`,
          header: () => <div className="min-w-[4rem] text-center">{bucket.name}</div>,
          cell: ({ row }) => (
            <div className="flex justify-center">
              <ReadOnlySyncCell
                file={row.original}
                target={bucket.id}
                active={activeMap?.get(row.original.object_key)}
              />
            </div>
          ),
        })
      })
      cols.push({
        accessorKey: "created_at",
        header: () => <div className="text-left">创建时间</div>,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {formatTime(row.original.created_at)}
          </span>
        ),
      })
      return cols
    },
    [enabledBuckets, activeMap],
  )

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: true,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    getRowId: (row) => String(row.id),
  })

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const skelWidths = skeletonWidths(enabledBuckets.length)

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
                          skelWidths[j] ?? "w-20",
                          j === 1 && "mx-auto", // 大小列居中
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
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">
                  暂无文件记录，可通过「新增文件」登记。
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
            className="flex-1 sm:flex-none"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            <ChevronLeft className="size-4" /> 上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 sm:flex-none"
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
