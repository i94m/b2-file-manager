import * as React from "react"
import { IconCheck, IconCopy } from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"

/** 复制按钮：点击后图标变为绿色对勾，2 秒后还原。 */
function CopyButton({
  value,
  className,
  onCopied,
  ...props
}: {
  value: string
  onCopied?: () => void
} & React.ComponentProps<"button">) {
  const { copyToClipboard, isCopied } = useCopyToClipboard()

  const handleCopy = () => {
    copyToClipboard(value)
    onCopied?.()
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "inline-flex items-center justify-center shrink-0 rounded-md transition-colors",
        "text-muted-foreground hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    >
      {isCopied
        ? <IconCheck className="size-4 text-green-500" />
        : <IconCopy className="size-4" />}
    </button>
  )
}

export { CopyButton }
