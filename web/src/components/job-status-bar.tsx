import { Ban, CheckCircle2, Loader2, XCircle } from "lucide-react"

import { useJobs } from "@/lib/use-jobs"
import { cn } from "@/lib/utils"

/**
 * 最近任务状态条：复用全局 JobsProvider 的连接状态与 job 列表，
 * 展示最近几条任务的状态。WebSocket 连接状态以圆点表示。
 */
export function JobStatusBar() {
  const { connected, jobs } = useJobs()

  const recent = Object.values(jobs)
    .sort((a, b) => b.id - a.id)
    .slice(0, 4)

  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            "size-2 rounded-full",
            connected ? "bg-emerald-500" : "bg-muted-foreground/40",
          )}
        />
        {connected ? "已连接" : "连接中…"}
      </span>
      {recent.length > 0 && (
        <>
          <span className="text-border">·</span>
          <div className="flex items-center gap-3 overflow-x-auto">
            {recent.map((j) => (
              <span key={j.id} className="inline-flex items-center gap-1 whitespace-nowrap">
                {j.status === "done" ? (
                  <CheckCircle2 className="size-3.5 text-emerald-500" />
                ) : j.status === "failed" ? (
                  <XCircle className="size-3.5 text-destructive" />
                ) : j.status === "cancelled" ? (
                  <Ban className="size-3.5 text-muted-foreground" />
                ) : (
                  <Loader2 className="size-3.5 animate-spin text-blue-500" />
                )}
                <span className="max-w-[10rem] truncate">{j.filename}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
