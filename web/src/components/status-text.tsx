import * as React from "react"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** 状态文字：active=绿 / muted=正常灰 / queued=黄。失败时 hover 展示错误。 */
export function StatusText({
  children,
  tone = "muted",
  error,
}: {
  children: React.ReactNode
  tone?: "active" | "muted" | "queued"
  error?: string | null
}) {
  const color =
    tone === "active"
      ? "text-emerald-600"
      : tone === "queued"
        ? "text-amber-500"
        : "text-muted-foreground"
  if (error) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("cursor-help text-xs font-medium", color)}>{children}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs break-all">{error}</TooltipContent>
      </Tooltip>
    )
  }
  return <span className={cn("text-xs font-medium", color)}>{children}</span>
}
