import { getApiKey } from "@/lib/api"

/** 当前 apikey 的 query 串（含 ?，无 key 时为空串）。 */
export function apiKeySearch(): string {
  const k = getApiKey()
  return k ? `?apikey=${encodeURIComponent(k)}` : ""
}

/**
 * 生成保留 apikey 的内部跳转地址。
 * getApiKey() 实时读 window.location.search，路由切换只改 pathname，
 * 目标地址不带 ?apikey= 就会丢 key（随后所有请求 401）——页面间跳转必须用它。
 */
export function withApiKey(to: string): string {
  return to + apiKeySearch()
}
