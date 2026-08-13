import * as React from "react"
import { X } from "lucide-react"
import { toast } from "sonner"

import { type FileItem } from "@/lib/types"
import { useJobs } from "@/lib/use-jobs"
import { cancelJob } from "@/lib/api"
import { formatBytes, formatDuration, formatRate } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

function StatRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{children}</span>
    </div>
  )
}

/**
 * 任务进度徽章：当 file 关联的 job 正在进行时显示蓝色百分比 + hover 详情。
 * 无活跃 job 时返回 null，由调用方决定 fallback（PresenceIcon 等）。
 */
export function JobProgressBadge({ file }: { file: FileItem }) {
  const { jobs, stats } = useJobs()
  const [cancelling, setCancelling] = React.useState(false)

  const job = file.job_id ? jobs[file.job_id] : undefined
  const active = job && (job.status === "uploading" || job.status === "queued")
  const stat = job ? stats[job.id] : undefined

  if (!active || !stat) return null

  const handleCancel = async () => {
    if (!job) return
    if (!confirm(`确认取消任务「${job.filename}」？`)) return
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

  const percent = stat.percent
  return (
    <HoverCard openDelay={150} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button className="inline-flex cursor-default items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300">
          <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
          {percent.toFixed(1)}%
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72" align="start">
        <div className="space-y-2">
          <div className="flex items-center justify-between border-b pb-2">
            <span className="max-w-[12rem] truncate text-sm font-medium">
              {file.filename || job.object_key}
            </span>
            <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100 dark:bg-blue-950 dark:text-blue-300">
              {percent.toFixed(1)}%
            </Badge>
          </div>
          <StatRow label="已传输">
            {formatBytes(job.progress)} / {formatBytes(job.size)}
          </StatRow>
          <StatRow label="速率">
            {stat.rate > 0 ? formatRate(stat.rate) : "—"}
          </StatRow>
          <StatRow label="剩余">{formatBytes(stat.remaining)}</StatRow>
          <StatRow label="预计">{formatDuration(stat.etaSec)}</StatRow>
          <StatRow label="已用">{formatDuration(stat.elapsedSec)}</StatRow>
          <div className="pt-1">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={handleCancel}
              disabled={cancelling}
            >
              <X className="size-3.5" /> {cancelling ? "取消中…" : "取消任务"}
            </Button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
