import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 格式化字节大小，与后端 app.py 的 format_bytes 行为一致。 */
export function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const
  let v = value
  for (const unit of units) {
    if (v < 1024 || unit === units[units.length - 1]) {
      return unit === "B" ? `${Math.round(v)} ${unit}` : `${v.toFixed(2)} ${unit}`
    }
    v /= 1024
  }
  return `${v.toFixed(2)} TiB`
}

/** 格式化字节速率，如 17.3 MiB/s（速率保留 1 位小数，更贴近常见显示）。 */
export function formatRate(bytesPerSec: number): string {
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s"] as const
  let v = bytesPerSec
  for (const unit of units) {
    if (v < 1024 || unit === units[units.length - 1]) {
      return unit === "B/s" ? `${Math.round(v)} ${unit}` : `${v.toFixed(1)} ${unit}`
    }
    v /= 1024
  }
  return `${v.toFixed(1)} TiB/s`
}

/** 格式化时长（秒），如 28 分、1.5 小时、45 秒。 */
export function formatDuration(sec: number | null): string {
  if (sec === null) return "—"
  if (sec < 1) return "0 秒"
  if (sec < 60) return `${Math.round(sec)} 秒`
  if (sec < 3600) return `${(sec / 60).toFixed(0)} 分`
  return `${(sec / 3600).toFixed(1)} 小时`
}

/** 格式化 epoch 秒为本地时间字符串，与后端 format_time 一致。 */
export function formatTime(epoch: number | null | undefined): string {
  if (!epoch) return "--"
  const d = new Date(epoch * 1000)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
