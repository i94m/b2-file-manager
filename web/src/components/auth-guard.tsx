import * as React from "react"
import { Loader2, LockKeyhole } from "lucide-react"

import { checkAuth } from "@/lib/api"
import { type AppInfo } from "@/lib/types"

/**
 * 鉴权拦截层：用当前 key 探测后端 /api/auth。
 * - 通过：把应用信息存入 context，渲染子组件（主应用复用，不重复请求）。
 * - 401 / 失败：显示纯文字「无权访问」。
 *
 * 页面本身也必须带 key（URL ?apikey=）才能用。
 */
const AppInfoContext = React.createContext<AppInfo | null>(null)

export function useAppInfo(): AppInfo | null {
  return React.useContext(AppInfoContext)
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = React.useState<"checking" | "unauth" | "ok">("checking")
  const [info, setInfo] = React.useState<AppInfo | null>(null)

  React.useEffect(() => {
    let cancelled = false
    checkAuth()
      .then((i) => {
        if (!cancelled) {
          setInfo(i)
          setStatus("ok")
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("unauth")
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (status === "ok" && info) {
    return <AppInfoContext.Provider value={info}>{children}</AppInfoContext.Provider>
  }

  if (status === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> 校验中…
        </div>
      </div>
    )
  }

  // unauth：纯文字提示
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
        <LockKeyhole className="size-8" />
        <p className="text-lg font-medium">无权访问</p>
      </div>
    </div>
  )
}
