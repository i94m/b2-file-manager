import * as React from "react"
import { Check, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

interface CheckboxProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  indeterminate?: boolean
  "aria-label"?: string
  className?: string
}

export const Checkbox = React.forwardRef<HTMLButtonElement, CheckboxProps>(
  function Checkbox({ checked, onCheckedChange, indeterminate, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={indeterminate ? "mixed" : checked}
        onClick={(e) => {
          e.stopPropagation()
          onCheckedChange(!checked)
        }}
        className={cn(
          "inline-flex size-4 shrink-0 items-center justify-center rounded border border-input transition-colors",
          (checked || indeterminate)
            ? "bg-primary border-primary text-primary-foreground"
            : "bg-transparent hover:bg-accent",
          className,
        )}
        {...rest}
      >
        {indeterminate ? (
          <Minus className="size-3" strokeWidth={4} />
        ) : checked ? (
          <Check className="size-3" strokeWidth={4} />
        ) : null}
      </button>
    )
  },
)
