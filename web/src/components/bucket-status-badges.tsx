import * as React from "react"
import { RefreshCw } from "lucide-react"
import { getBucketHealth } from "@/lib/api"
import type { BucketHealth, BucketHealthEntry } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"

type State = "ok" | "err" | "unknown"

function dotClass(state: State) {
  if (state === "ok") return "bg-emerald-500"
  if (state === "err") return "bg-red-500"
  return "bg-muted-foreground/40"
}

function stateOf(entry: BucketHealthEntry | null, loading: boolean): State {
  if (loading || !entry) return "unknown"
  return entry.ok ? "ok" : "err"
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground break-all">{children}</span>
    </div>
  )
}

function DetailCard({
  label,
  bucket,
  entry,
}: {
  label: string
  bucket: string
  entry: BucketHealthEntry | null
}) {
  return (
    <HoverCardContent align="start" className="w-72">
      <div className="space-y-1.5">
        <div className="mb-1 text-sm font-semibold">
          {label}: <code className="font-mono">{bucket}</code>
        </div>
        {entry?.ok === false && entry.error ? (
          <div className="mb-1 break-all rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {entry.error}
          </div>
        ) : null}
        <Row label="状态">
          {entry?.ok ? "✓ 可访问" : entry?.ok === false ? "✗ 不可访问" : "—"}
        </Row>
        <Row label="延迟">
          {entry?.latency_ms != null ? `${entry.latency_ms} ms` : "—"}
        </Row>
        <Row label="HTTP">{entry?.status_code ?? "—"}</Row>
        <Row label="Region">{entry?.region ?? "—"}</Row>
        <Row label="版本控制">{entry?.versioning ?? "—"}</Row>
        <Row label="公开读">
          {entry?.public == null ? "未知" : entry.public ? "⚠️ 公开" : "私有"}
        </Row>
        {entry?.redundancy ? <Row label="冗余">{entry.redundancy}</Row> : null}
        {entry?.storage_class ? <Row label="存储类">{entry.storage_class}</Row> : null}
        <Row label="寻址风格">{entry?.addressing_style ?? "—"}</Row>
        <div className="pt-1 text-[10px] text-muted-foreground break-all">
          {entry?.endpoint ?? "—"}
        </div>
      </div>
    </HoverCardContent>
  )
}

function BucketBadge({
  label,
  bucket,
  entry,
  loading,
}: {
  label: string
  bucket: string
  entry: BucketHealthEntry | null
  loading: boolean
}) {
  // 加载态：纯灰色「检查中…」，无 hover 卡片
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
        检查中…
      </span>
    )
  }

  const state = stateOf(entry, false)
  const trigger = (
    <span
      className="inline-flex cursor-default items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs"
      title={
        entry?.ok === false
          ? `${label} 不可访问：${entry.error}`
          : `${label}: ${bucket}（悬停查看详情）`
      }
    >
      <span className={cn("size-1.5 rounded-full", dotClass(state))} />
      {label}: <code className="font-mono font-medium text-foreground">{bucket || "…"}</code>
    </span>
  )

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{trigger}</HoverCardTrigger>
      <DetailCard label={label} bucket={bucket} entry={entry} />
    </HoverCard>
  )
}

export function BucketStatusBadges({
  selfBucket,
  beijingEnabled,
  beijingBucket,
  trailing,
}: {
  selfBucket: string
  beijingEnabled: boolean
  beijingBucket: string
  /** 渲染在桶徽章之后、刷新按钮之前的额外元素（如连接状态）。 */
  trailing?: React.ReactNode
}) {
  const [health, setHealth] = React.useState<BucketHealth | null>(null)
  const [loading, setLoading] = React.useState(true)

  const check = React.useCallback(async () => {
    setLoading(true)
    try {
      setHealth(await getBucketHealth())
    } catch {
      setHealth(null)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    check()
  }, [check])

  return (
    <>
      <BucketBadge
        label="Bucket"
        bucket={selfBucket}
        entry={health?.self ?? null}
        loading={loading}
      />
      {beijingEnabled && (
        <BucketBadge
          label="北京桶"
          bucket={beijingBucket}
          entry={health?.beijing ?? null}
          loading={loading}
        />
      )}
      {trailing}
      <button
        type="button"
        onClick={check}
        disabled={loading}
        title="重新检测桶连通性"
        className="order-last inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <RefreshCw className={cn("size-3", loading && "animate-spin")} />
      </button>
    </>
  )
}
