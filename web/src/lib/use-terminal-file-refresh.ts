import * as React from "react"

import { getFile } from "@/lib/api"
import { useJobs } from "@/lib/use-jobs"
import { type FileItem } from "@/lib/types"

/**
 * 任务终态后只更新受影响的行（按 job_id 匹配当前页），不整表刷新。
 * 管理页与公开页共用：Socket.IO 推送的 job 进入终态（done/failed/cancelled/error）
 * 时，500ms 后批量 getFile 拉取对应文件记录并 patch 到列表。
 */
export function useTerminalFileRefresh(
  files: FileItem[],
  patchFile: (updated: FileItem) => void,
) {
  const { jobs } = useJobs()
  const terminalRef = React.useRef<Set<number>>(new Set())
  const filesRef = React.useRef(files)
  filesRef.current = files
  React.useEffect(() => {
    const finishedIds = new Set<number>()
    for (const job of Object.values(jobs)) {
      if (["done", "failed", "cancelled", "error"].includes(job.status)) {
        if (!terminalRef.current.has(job.id)) {
          terminalRef.current.add(job.id)
          finishedIds.add(job.id)
        }
      }
    }
    if (finishedIds.size === 0) return
    const affected = filesRef.current.filter(
      (f) => f.job_id !== null && finishedIds.has(f.job_id),
    )
    if (affected.length === 0) return
    const t = setTimeout(() => {
      affected.forEach((f) => {
        getFile(f.id).then(patchFile).catch((e) => console.error(e))
      })
    }, 500)
    return () => clearTimeout(t)
  }, [jobs, patchFile])
}
