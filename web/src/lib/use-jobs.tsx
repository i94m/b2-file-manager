import * as React from "react"
import { io } from "socket.io-client"

import { getApiKey } from "@/lib/api"
import { type JobStats, type JobUpdate } from "@/lib/types"

/** 滑动窗口保留的样本数（job_update 约每 0.5s 一次，8 个 ≈ 4s 历史用于平滑速率）。 */
const SAMPLE_LIMIT = 8

interface Sample {
  t: number // 收到时刻（ms）
  progress: number // 累计已传输字节
}

interface JobState extends JobUpdate {
  samples: Sample[]
}

export interface JobsSnapshot {
  /** 连接状态。 */
  connected: boolean
  /** job_id → 最新 job 状态。 */
  jobs: Record<number, JobUpdate>
  /** job_id → 实时统计（仅在上传中才有意义）。 */
  stats: Record<number, JobStats>
}

const JobsContext = React.createContext<JobsSnapshot>({
  connected: false,
  jobs: {},
  stats: {},
})

/** 计算 job 的实时统计。速率取滑动窗口内的平均吞吐，避免抖动。 */
function computeStats(job: JobState, now: number): JobStats {
  const size = job.size || 0
  const progress = job.progress || 0
  const percent = size > 0 ? Math.min(100, (progress / size) * 100) : 0
  const remaining = size > 0 ? Math.max(0, size - progress) : 0

  // 已用：从 started_at 到现在（未完成）或 finished_at（已完成）
  let elapsedSec: number | null = null
  const start = job.started_at
  if (start) {
    const end = job.finished_at ? job.finished_at * 1000 : now
    elapsedSec = Math.max(0, (end - start * 1000) / 1000)
  }

  // 速率：用窗口内首末样本的平均吞吐
  let rate = 0
  let etaSec: number | null = null
  const samples = job.samples
  if (samples.length >= 2) {
    const first = samples[0]
    const last = samples[samples.length - 1]
    const dt = (last.t - first.t) / 1000
    const dBytes = last.progress - first.progress
    if (dt > 0 && dBytes >= 0) {
      rate = dBytes / dt
      if (rate > 0 && remaining > 0) {
        etaSec = remaining / rate
      } else if (remaining === 0) {
        etaSec = 0
      }
    }
  }

  return { percent, rate, remaining, etaSec, elapsedSec }
}

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = React.useState(false)
  const [jobs, setJobs] = React.useState<Record<number, JobUpdate>>({})
  const [stats, setStats] = React.useState<Record<number, JobStats>>({})
  const ref = React.useRef<Record<number, JobState>>({})

  // 定时刷新统计（速率/剩余随时间变化，即便没有新 job_update）
  React.useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      const next: Record<number, JobStats> = {}
      let changed = false
      for (const [id, job] of Object.entries(ref.current)) {
        if (job.status === "uploading" || job.status === "queued") {
          next[Number(id)] = computeStats(job, now)
          changed = true
        }
      }
      if (changed) setStats(next)
    }, 500)
    return () => clearInterval(timer)
  }, [])

  React.useEffect(() => {
    if (!getApiKey()) return
    const socket = io({ transports: ["websocket", "polling"], query: { apikey: getApiKey() } })

    const upsert = (job: JobUpdate) => {
      const prev = ref.current[job.id]
      const now = Date.now()
      const samples = prev ? [...prev.samples] : []
      // 仅在上传中且未暂停时累计样本（progress 在变化）
      if (job.status === "uploading" && !job.paused) {
        samples.push({ t: now, progress: job.progress })
        if (samples.length > SAMPLE_LIMIT) samples.shift()
      } else if (job.status === "done" || job.status === "error") {
        samples.length = 0
      }
      const state: JobState = { ...job, samples }
      ref.current[job.id] = state
      setJobs((j) => ({ ...j, [job.id]: job }))
      // 立即算一次统计
      setStats((s) => ({ ...s, [job.id]: computeStats(state, now) }))
    }

    socket.on("connect", () => setConnected(true))
    socket.on("disconnect", () => setConnected(false))
    socket.on("connect_error", () => setConnected(false))
    socket.on("jobs_snapshot", (items: JobUpdate[]) => {
      const next: Record<number, JobState> = {}
      items.forEach((j) => {
        next[j.id] = { ...j, samples: [] }
      })
      ref.current = next
      setJobs(Object.fromEntries(items.map((j) => [j.id, j])))
      // 清理已不存在的 job 的统计
      setStats({})
    })
    socket.on("job_update", upsert)

    return () => {
      socket.disconnect()
    }
  }, [])

  return (
    <JobsContext.Provider value={{ connected, jobs, stats }}>
      {children}
    </JobsContext.Provider>
  )
}

export function useJobs(): JobsSnapshot {
  return React.useContext(JobsContext)
}
