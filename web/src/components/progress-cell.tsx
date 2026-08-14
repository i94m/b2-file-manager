import * as React from "react"
import { Pause } from "lucide-react"

import { type FileItem } from "@/lib/types"
import { useJobs } from "@/lib/use-jobs"
import { formatRate } from "@/lib/utils"

/**
 * 任务进度徽章：当 file 关联的 job 正在上传/下载时显示蓝色 百分比+速率。
 * 仅在 status=uploading 时渲染（queued 由调用方处理）。无活跃 job 时返回 null。
 */
export function JobProgressBadge({ file }: { file: FileItem }) {
  const { jobs, stats } = useJobs()

  const job = file.job_id ? jobs[file.job_id] : undefined
  const active = job && job.status === "uploading"
  const stat = job ? stats[job.id] : undefined

  if (!active || !stat) return null

  if (job.paused) {
    return (
      <span className="inline-flex cursor-default items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        <Pause className="size-3" />
        已暂停 {stat.percent.toFixed(0)}%
      </span>
    )
  }

  const percent = stat.percent
  return (
    <span className="inline-flex cursor-default items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium tabular-nums text-blue-700 dark:bg-blue-950 dark:text-blue-300">
      <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
      {percent.toFixed(0)}% {stat.rate > 0 ? formatRate(stat.rate) : ""}
    </span>
  )
}
