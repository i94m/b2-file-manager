import { cn } from "@/lib/utils"
import type { BucketHealthEntry } from "@/lib/types"

/** 桶连通性状态点：绿=可访问 / 红=不可访问 / 灰=未知（title 提示简况）。 */
export function HealthDot({ entry }: { entry: BucketHealthEntry | null | undefined }) {
  const cls =
    entry == null
      ? "bg-muted-foreground/40"
      : entry.ok
        ? "bg-emerald-500"
        : "bg-red-500"
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", cls)}
      title={
        entry == null
          ? "未检测"
          : entry.ok
            ? `可访问${entry.latency_ms != null ? `（${entry.latency_ms}ms）` : ""}`
            : `不可访问：${entry.error ?? ""}`
      }
    />
  )
}

/** hover 详情行：标签 + 值。 */
function HealthRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground break-all">{children}</span>
    </div>
  )
}

/** 桶健康详情卡内容（桶 Tab 标题/浏览区标题 hover 共用）。 */
export function BucketHealthCard({
  name,
  bucketName,
  entry,
}: {
  name: string
  bucketName: string
  entry: BucketHealthEntry | null | undefined
}) {
  return (
    <div className="space-y-1.5">
      <div className="mb-1 text-sm font-semibold">
        {name}: <code className="font-mono">{bucketName}</code>
      </div>
      {entry?.ok === false && entry.error ? (
        <div className="mb-1 break-all rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {entry.error}
        </div>
      ) : null}
      <HealthRow label="状态">
        {entry?.ok ? "✓ 可访问" : entry?.ok === false ? "✗ 不可访问" : "—"}
      </HealthRow>
      <HealthRow label="延迟">
        {entry?.latency_ms != null ? `${entry.latency_ms} ms` : "—"}
      </HealthRow>
      <HealthRow label="HTTP">{entry?.status_code ?? "—"}</HealthRow>
      <HealthRow label="Region">{entry?.region ?? "—"}</HealthRow>
      <HealthRow label="版本控制">{entry?.versioning ?? "—"}</HealthRow>
      <HealthRow label="公开读">
        {entry?.public == null ? "未知" : entry.public ? "⚠️ 公开" : "私有"}
      </HealthRow>
      {entry?.redundancy ? <HealthRow label="冗余">{entry.redundancy}</HealthRow> : null}
      {entry?.storage_class ? <HealthRow label="存储类">{entry.storage_class}</HealthRow> : null}
      <HealthRow label="寻址风格">{entry?.addressing_style ?? "—"}</HealthRow>
      <div className="pt-1 text-[10px] text-muted-foreground break-all">
        {entry?.endpoint ?? "—"}
      </div>
    </div>
  )
}
