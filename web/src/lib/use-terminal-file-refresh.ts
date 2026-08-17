import * as React from "react"

import { getFile } from "@/lib/api"
import { useJobs } from "@/lib/use-jobs"
import { type FileItem } from "@/lib/types"

/**
 * 任务终态后只更新受影响的行（按 job_id 匹配当前页），不整表刷新。
 * 管理页与公开页共用：Socket.IO 推送的 job 进入终态（done/failed/cancelled/error）
 * 时，500ms 后批量 getFile 拉取对应文件记录并 patch 到列表。
 *
 * 注意：定时器不能放在 effect 清理函数里取消——上传道与下载道可并行，另一条道
 * 的进度事件（约每 0.5s 一次）会触发重渲染，清理函数随之反复清除尚未触发的
 * 刷新定时器，导致先完成的任务永远等不到行刷新。改为「去重后独立调度」，
 * 定时器只在组件卸载时统一清理。
 */
export function useTerminalFileRefresh(
  files: FileItem[],
  patchFile: (updated: FileItem) => void,
) {
  const { jobs } = useJobs()
  const terminalRef = React.useRef<Set<number>>(new Set())
  const timersRef = React.useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const filesRef = React.useRef(files)
  filesRef.current = files

  React.useEffect(() => {
    const finishedIds: number[] = []
    for (const job of Object.values(jobs)) {
      if (!["done", "failed", "cancelled", "error"].includes(job.status)) continue
      if (terminalRef.current.has(job.id)) continue
      terminalRef.current.add(job.id)
      finishedIds.push(job.id)
    }
    if (finishedIds.length === 0) return
    // 延迟到后端 DB 落库之后（emit 前已写完，此处主要做事件批量合并）
    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      // 触发时刻再匹配当前页：期间行可能已被删/换页，find 不到则跳过
      for (const id of finishedIds) {
        const f = filesRef.current.find((x) => x.job_id === id)
        if (!f) continue
        getFile(f.id).then(patchFile).catch((e) => console.error(e))
      }
    }, 500)
    timersRef.current.add(timer)
  }, [jobs, patchFile])

  // 卸载时清理未触发的定时器（timersRef 的 Set 对象本身不变，仅内容增减）
  React.useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach(clearTimeout)
      timers.clear()
    }
  }, [])
}
