import * as React from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"

export interface ConfirmOptions {
  title?: string
  description: React.ReactNode
  confirmText?: string
  cancelText?: string
  /** 确认按钮使用红色（用于删除/取消等破坏性操作）。 */
  destructive?: boolean
}

/**
 * 命令式确认框 hook，返回 [confirm, dialog]。
 *
 * 用法：
 *   const [confirm, confirmDialog] = useConfirm()
 *   if (!await confirm({ description: "确认删除？" })) return
 *   return (<> ... {confirmDialog} </>)
 *
 * 底层基于 shadcn AlertDialog（Modal），替代原生 window.confirm。
 */
export function useConfirm() {
  const [options, setOptions] = React.useState<ConfirmOptions | null>(null)
  const resolver = React.useRef<((v: boolean) => void) | null>(null)

  const confirm = React.useCallback((opts: ConfirmOptions) => {
    setOptions(opts)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const handleClose = React.useCallback((result: boolean) => {
    resolver.current?.(result)
    resolver.current = null
    setOptions(null)
  }, [])

  const dialog = (
    <AlertDialog open={options !== null} onOpenChange={(open) => { if (!open) handleClose(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{options?.title ?? "请确认"}</AlertDialogTitle>
          <AlertDialogDescription>{options?.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{options?.cancelText ?? "取消"}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(options?.destructive && "bg-destructive text-white hover:bg-destructive/90")}
            onClick={() => handleClose(true)}
          >
            {options?.confirmText ?? "确认"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return [confirm, dialog] as const
}
