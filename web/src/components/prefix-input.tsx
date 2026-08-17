import * as React from "react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { getPrefixHistory, validatePrefix } from "@/lib/prefix"

/**
 * 目录（prefix）输入：组合输入框 + 历史快捷芯片 + 校验提示 + object key 预览。
 *
 * 预览用真实文件名（后端不再改名为 UUID），让用户看到最终 object key 的目录段。
 * 完整 object = 应用固定前缀(bucket_prefix) + 此目录 + 文件名，应用前缀对用户不可见。
 */
export function PrefixInput({
  value,
  onChange,
  filename,
  className,
}: {
  value: string
  onChange: (v: string) => void
  filename?: string
  className?: string
}) {
  const history = React.useMemo(() => getPrefixHistory(), [value])
  const { valid, error, normalized } = validatePrefix(value)

  return (
    <div className={cn("space-y-1.5", className)}>
      <Input
        placeholder="如 backups/2026"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!valid}
      />
      {history.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {history.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => onChange(h)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-xs transition-colors",
                value === h
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-accent"
              )}
            >
              {h}
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {valid && (
        <p className="text-xs text-muted-foreground">
          ObjectKey: <code className="font-mono">{normalized || "(根目录)"}/{filename ?? "文件名"}</code>
        </p>
      )}
    </div>
  )
}
