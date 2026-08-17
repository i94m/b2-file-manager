import * as React from "react"

import { getBuckets, type Bucket } from "@/lib/api"

interface BucketsSnapshot {
  /** 桶列表（含禁用桶；顺序：sort_order → id，由桶管理拖动排序维护）。 */
  buckets: Bucket[]
  loading: boolean
  /** 重新拉取桶列表（桶管理增删改后调用）。 */
  refresh: () => Promise<void>
}

const BucketsContext = React.createContext<BucketsSnapshot>({
  buckets: [],
  loading: false,
  refresh: async () => {},
})

/** 桶数据 Context：所有按桶渲染的组件（表格列/徽章/浏览区）从这里取桶。 */
export function BucketsProvider({ children }: { children: React.ReactNode }) {
  const [buckets, setBuckets] = React.useState<Bucket[]>([])
  const [loading, setLoading] = React.useState(true)

  const refresh = React.useCallback(async () => {
    try {
      setBuckets(await getBuckets())
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <BucketsContext.Provider value={{ buckets, loading, refresh }}>
      {children}
    </BucketsContext.Provider>
  )
}

export function useBuckets(): BucketsSnapshot {
  return React.useContext(BucketsContext)
}
