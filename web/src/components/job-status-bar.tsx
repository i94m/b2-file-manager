import * as React from "react"
import { Ban, CheckCircle2, CloudDownload, CloudUpload, Loader2, MoreVertical, Pause, Play, Trash2, X, XCircle } from "lucide-react"
import { toast } from "sonner"

import { useJobs } from "@/lib/use-jobs"
import { cancelJob, deleteJob, pauseJob, resumeJob } from "@/lib/api"
import type { JobUpdate } from "@/lib/types"
import { useConfirm } from "@/lib/use-confirm"
import { cn, formatBytes, formatRate, formatTime } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
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
  transfer: "直传",
}

/** 任务类型文案：上传/下载/直传任务追加目标桶名（如「上传(北京桶)」）。 */
function jobKindLabel(job: JobUpdate): string {
  const base = KIND_LABEL[job.kind] ?? job.kind
  if ((job.kind === "upload" || job.kind === "download" || job.kind === "transfer") && job.bucket_name) {
    return `${base}(${job.bucket_name})`
  }
  return base
}

/** 传输方向视觉样式：上传=蓝 / 下载=绿（fetch 归下载），彩色图标 + 淡淡的行底色一眼可辨。 */
const DIRECTION_STYLE = {
  upload: {
    icon: CloudUpload,
    iconClass: "text-blue-500",
    rowClass: "bg-blue-500/[0.04]",
  },
  download: {
    icon: CloudDownload,
    iconClass: "text-emerald-500",
    rowClass: "bg-emerald-500/[0.04]",
  },
} as const

/** 任务是否仍在进行（排队中或传输中；不含已暂停 / 已结束）。 */
function isActiveJob(j: JobUpdate): boolean {
  return j.status === "queued" || j.status === "uploading"
}

/** 传输列表（最近任务，放文件列表旁边）：与左侧一致的 Tabs，分「上传列表 / 下载列表」。 */
export function JobsTable() {
  const { jobs } = useJobs()

  const all = Object.values(jobs)
  const uploads = all
    .filter((j) => j.kind === "upload" || j.kind === "transfer")
    .sort((a, b) => b.id - a.id)
    .slice(0, 15)
  const downloads = all
    .filter((j) => j.kind !== "upload" && j.kind !== "transfer")
    .sort((a, b) => b.id - a.id)
    .slice(0, 15)
  // 角标只统计「正在进行」的任务数（基于全部任务，不受最近 15 条截断影响）
  const activeUploads = all.filter((j) => (j.kind === "upload" || j.kind === "transfer") && isActiveJob(j)).length
  const activeDownloads = all.filter((j) => j.kind !== "upload" && j.kind !== "transfer" && isActiveJob(j)).length

  if (uploads.length === 0 && downloads.length === 0) return null

  // 默认打开有「正在进行」任务的方向；都没有则回退到有记录的方向
  const defaultValue =
    activeUploads > 0 || (activeUploads === activeDownloads && uploads.length > 0) || downloads.length === 0
      ? "upload"
      : "download"

  return (
    <Tabs defaultValue={defaultValue} className="min-w-0">
      <TabsList>
        <TabsTrigger value="upload" className="gap-1.5">
          <CloudUpload className="size-4 text-blue-500" />
          上传列表
          {activeUploads > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground">{activeUploads}</span>
          )}
        </TabsTrigger>
        <TabsTrigger value="download" className="gap-1.5">
          <CloudDownload className="size-4 text-emerald-500" />
          下载列表
          {activeDownloads > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground">{activeDownloads}</span>
          )}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="upload">
        <TransferTable direction="upload" jobs={uploads} />
      </TabsContent>
      <TabsContent value="download">
        <TransferTable direction="download" jobs={downloads} />
      </TabsContent>
    </Tabs>
  )
}

/** 单个方向的传输表格（空时给占位提示）；行底色 + 类型列彩色图标区分方向。 */
function TransferTable({ direction, jobs }: { direction: keyof typeof DIRECTION_STYLE; jobs: JobUpdate[] }) {
  const { stats } = useJobs()
  const dir = DIRECTION_STYLE[direction]
  const dirName = direction === "upload" ? "上传" : "下载"

  if (jobs.length === 0) {
    return (
      <div className="flex items-center justify-center gap-1.5 rounded-lg border px-4 py-8 text-xs text-muted-foreground">
        <dir.icon className={cn("size-3.5", dir.iconClass)} />
        暂无{dirName}任务
      </div>
    )
  }

  return (
    <div className="rounded-lg border">
      <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">状态</TableHead>
          <TableHead>文件名</TableHead>
          <TableHead className="w-24">类型</TableHead>
          <TableHead className="w-20 text-right">大小</TableHead>
          <TableHead className="w-36">进度</TableHead>
          <TableHead className="w-32">时间</TableHead>
          <TableHead className="w-12 text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((j) => {
          const stat = stats[j.id]
          const pct = j.size > 0 ? Math.min(100, (j.progress / j.size) * 100) : 0
          const kindLabel = jobKindLabel(j)
          return (
            <TableRow key={j.id} className={dir.rowClass}>
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
                <span className="block max-w-[14rem] truncate text-xs" title={j.filename}>
                  {j.filename}
                </span>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <span className="flex items-center gap-1" title={kindLabel}>
                  <dir.icon className={cn("size-3.5 shrink-0", dir.iconClass)} />
                  <span className="truncate">{kindLabel}</span>
                </span>
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
                ) : j.status === "queued" ? (
                  <span className="text-amber-500">排队中</span>
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
                <JobActions job={j} />
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
    </div>
  )
}

function JobActions({ job }: { job: JobUpdate }) {
  const [busy, setBusy] = React.useState(false)
  const [confirm, confirmDialog] = useConfirm()
  const isActive = isActiveJob(job)
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
  const handleDelete = async () => {
    if (!await confirm({
      title: "删除记录",
      description: `确认删除任务记录「${job.filename}」？仅删除任务记录，不影响文件与桶内对象。`,
      confirmText: "删除记录",
      destructive: true,
    })) return
    setBusy(true)
    try {
      const r = await deleteJob(job.id)
      toast(r.message)
    } catch (e) {
      toast.error("删除失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="inline-flex items-center justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="任务操作"
            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <MoreVertical className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isActive ? (
            <>
              <DropdownMenuItem onClick={handlePauseResume} disabled={busy}>
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : job.paused ? (
                  <Play className="size-3.5" />
                ) : (
                  <Pause className="size-3.5" />
                )}
                {job.paused ? "继续" : "暂停"}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={handleCancel} disabled={busy}>
                <X className="size-3.5" />
                取消任务
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem variant="destructive" onClick={handleDelete} disabled={busy}>
              <Trash2 className="size-3.5" />
              删除记录
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmDialog}
    </div>
  )
}
