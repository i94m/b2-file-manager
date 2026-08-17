/**
 * prefix（目录）输入的校验 + localStorage 历史。
 *
 * 校验规则与后端 backblaze_upload.clean_prefix 对齐，但前端更严格：
 * 后端静默清洗首尾 / 与连续 /，前端直接报错让用户感知。
 * 提交时仍发送 normalized 结果，后端 clean_prefix 再跑一遍结果一致。
 */

export interface PrefixValidation {
  valid: boolean
  error: string | null
  normalized: string
}

export function validatePrefix(raw: string): PrefixValidation {
  const value = raw.replace(/\\/g, "/").trim()
  if (!value) return { valid: true, error: null, normalized: "" }
  if (/^\/|\/$/.test(value)) {
    return {
      valid: false,
      error: "不能以 / 开头或结尾",
      normalized: value.replace(/^\/+|\/+$/g, ""),
    }
  }
  if (!/^[\w\u4e00-\u9fa5.\-/]+$/.test(value)) {
    return { valid: false, error: "只允许字母、数字、中文、- _ . /", normalized: value }
  }
  const parts = value.split("/")
  if (parts.includes("..")) return { valid: false, error: "不能包含 ..", normalized: value }
  if (parts.includes("")) return { valid: false, error: "不能有连续的 /", normalized: value }
  return { valid: true, error: null, normalized: parts.filter((p) => p !== ".").join("/") }
}

const HISTORY_KEY = "prefix-history"
const MAX_HISTORY = 8

export function getPrefixHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string").slice(0, MAX_HISTORY) : []
  } catch {
    return []
  }
}

export function getLastPrefix(): string {
  return getPrefixHistory()[0] ?? ""
}

/**
 * 从文件名推断存储目录：去掉扩展名后，去掉最后一个 "_片段"（随机短后缀）。
 * 例：opus5_delivery_20260812_1HdRlE.zip → opus5_delivery_20260812；
 *     fable_delivery_20260813_6vxPKH.zip → fable_delivery_20260813。
 * 无 "_" 或去掉后为空（无法推断）时返回 null，调用方保持原值。
 */
export function dirnameFromFilename(filename: string): string | null {
  const stem = filename.replace(/\.[^./\\]+$/, "")
  const idx = stem.lastIndexOf("_")
  if (idx <= 0) return null
  return stem.slice(0, idx) || null
}

export function addPrefix(p: string): void {
  const value = p.trim()
  if (!value) return
  let history = getPrefixHistory()
  history = [value, ...history.filter((x) => x !== value)].slice(0, MAX_HISTORY)
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
  } catch {
    /* localStorage 不可用（隐私模式等），静默忽略 */
  }
}
