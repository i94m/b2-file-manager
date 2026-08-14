import * as React from "react"
import { Ban, CheckCircle2, Loader2, Pause, Play, X, XCircle } from "lucide-react"
import { toast } from "sonner"

import { useJobs } from "@/lib/use-jobs"
import { cancelJob, pauseJob, resumeJob } from "@/lib/api"
import { useConfirm } from "@/lib/use-confirm"
import { cn, formatBytes, formatRate, formatTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/** 连接状态指示器（放顶部 header）：表示任务进度实时推送通道（Socket.IO）。 */
export function ConnectionStatus() {
  const { connected } = useJobs()
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground"
      title={connected ? "任务进度实时推送通道：已连接" : "任务进度实时推送通道：连接中…"}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          connected ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
      {connected ? "实时推送·已连接" : "实时推送·连接中…"}
    </span>
  )
}

const KIND_LABEL: Record<string, string> = {
  fetch: "下载",
  download: "下载",
  upload: "上传",
  upload_beijing: "上传(北京)",
  download_beijing: "下载(北京)",
}

/** 最近任务结果表格（放文件列表下方）。 */
export function JobsTable() {
  const { jobs, stats } = useJobs()

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
            <TableHead className="w-40">进度</TableHead>
            <TableHead className="w-32">时间</TableHead>
            <TableHead className="w-16 text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recent.map((j) => {
            const stat = stats[j.id]
            const pct = j.size > 0 ? Math.min(100, (j.progress / j.size) * 100) : 0
            const isActive = j.status === "queued" || j.status === "uploading"
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
                  {j.status === "done" ? (
                    "完成"
                  ) : j.status === "failed" ? (
                    <span className="text-destructive">失败</span>
                  ) : j.status === "cancelled" ? (
                    "已取消"
                  ) : j.paused ? (
                    <span className="text-amber-600 dark:text-amber-400">
                      已暂停 · {pct.toFixed(0)}%
                    </span>
                  ) : j.status === "uploading" && stat ? (
                    <div className="space-y-0.5">
                      <div className="text-blue-600 dark:text-blue-400">
                        {pct.toFixed(0)}%{stat.rate > 0 ? ` · ${formatRate(stat.rate)}` : ""}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {formatBytes(j.progress)} / {formatBytes(j.size)}
                      </div>
                    </div>
                  ) : (
                    `${pct.toFixed(0)}%`
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatTime(j.created_at)}
                </TableCell>
                <TableCell className="text-right">
                  {isActive && <JobActions job={j} />}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function JobActions({ job }: { job: { id: number; filename: string; paused: boolean } }) {
  const [busy, setBusy] = React.useState(false)
  const [confirm, confirmDialog] = useConfirm()
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
  return (
    <div className="inline-flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-xs text-muted-foreground"
        onClick={handlePauseResume}
        disabled={busy}
        title={job.paused ? "继续" : "暂停"}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> :
          job.paused ? <Play className="size-3" /> : <Pause className="size-3" />}
        {job.paused ? "继续" : "暂停"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-xs text-muted-foreground hover:text-destructive"
        onClick={handleCancel}
        disabled={busy}
        title="取消任务"
      >
        <X className="size-3" />
        取消
      </Button>
      {confirmDialog}
    </div>
  )
}
