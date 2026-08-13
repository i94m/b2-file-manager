import { Ban, CheckCircle2, Loader2, XCircle } from "lucide-react"

import { useJobs } from "@/lib/use-jobs"
import { cn, formatBytes, formatTime } from "@/lib/utils"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/** 连接状态指示器（放顶部 header）。 */
export function ConnectionStatus() {
  const { connected } = useJobs()
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          connected ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
      {connected ? "已连接" : "连接中…"}
    </span>
  )
}

const KIND_LABEL: Record<string, string> = {
  fetch: "下载",
  download: "下载",
  upload: "上传",
}

/** 最近任务结果表格（放文件列表下方）。 */
export function JobsTable() {
  const { jobs } = useJobs()

  const recent = Object.values(jobs)
    .sort((a, b) => b.id - a.id)
    .slice(0, 15)

  if (recent.length === 0) return null

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-2 text-sm font-medium">任务记录</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">状态</TableHead>
            <TableHead>文件名</TableHead>
            <TableHead className="w-16">类型</TableHead>
            <TableHead className="w-20 text-right">大小</TableHead>
            <TableHead className="w-24">进度</TableHead>
            <TableHead className="w-36">时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recent.map((j) => {
            const pct = j.size > 0 ? Math.min(100, (j.progress / j.size) * 100) : 0
            return (
              <TableRow key={j.id}>
                <TableCell>
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    {j.status === "done" ? (
                      <CheckCircle2 className="size-3.5 text-emerald-500" />
                    ) : j.status === "failed" ? (
                      <XCircle className="size-3.5 text-destructive" />
                    ) : j.status === "cancelled" ? (
                      <Ban className="size-3.5 text-muted-foreground" />
                    ) : (
                      <Loader2 className="size-3.5 animate-spin text-blue-500" />
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="block max-w-[20rem] truncate text-xs" title={j.filename}>
                    {j.filename}
                  </span>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {KIND_LABEL[j.kind] ?? j.kind}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                  {formatBytes(j.size)}
                </TableCell>
                <TableCell className="text-xs tabular-nums text-muted-foreground">
                  {j.status === "done"
                    ? "完成"
                    : j.status === "failed"
                      ? "失败"
                      : j.status === "cancelled"
                        ? "已取消"
                        : `${pct.toFixed(0)}%`}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatTime(j.created_at)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
