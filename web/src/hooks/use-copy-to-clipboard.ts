import * as React from "react"

/** 复制到剪贴板：优先 Clipboard API，非安全上下文回退 execCommand（不抢焦点）。 */
export function useCopyToClipboard({ timeout = 2000 } = {}) {
  const [isCopied, setIsCopied] = React.useState(false)
  const timerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined)

  const copyToClipboard = React.useCallback(async (value: string) => {
    if (!value) return false

    let ok = false
    try {
      if (navigator?.clipboard?.writeText) {
        // Clipboard API —— 需安全上下文（HTTPS 或 localhost）
        await navigator.clipboard.writeText(value)
        ok = true
      } else {
        // 非安全上下文（如 http://非localhost 域名）回退到 execCommand。
        // 用隐藏 span + Selection 选区复制，不调用 .focus()，避免抢走焦点
        // 而触发外层 Radix Popover/Dialog 的 onFocusOutside 自动关闭。
        const selection = window.getSelection()
        if (selection) {
          const span = document.createElement("span")
          span.textContent = value
          span.style.whiteSpace = "pre"
          span.style.position = "fixed"
          span.style.top = "-9999px"
          span.setAttribute("aria-hidden", "true")
          document.body.appendChild(span)

          const range = document.createRange()
          range.selectNodeContents(span)
          selection.removeAllRanges()
          selection.addRange(range)

          ok = document.execCommand("copy")
          selection.removeAllRanges()
          document.body.removeChild(span)
        }
      }
    } catch {
      ok = false
    }

    if (ok) {
      setIsCopied(true)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setIsCopied(false), timeout)
    }
    return ok
  }, [timeout])

  React.useEffect(() => () => clearTimeout(timerRef.current), [])

  return { isCopied, copyToClipboard }
}
