import * as React from "react"
import { ArrowRightLeft, Cloud, Download, Info, Loader2, MoreVertical, Pencil, Search, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { type BucketObject, type BucketHealthEntry } from "@/lib/types"
import { deleteObject, getObjects, renameObject, serverDownload, uploadFile } from "@/lib/api"
import { useConfirm } from "@/lib/use-confirm"
import { cn, formatBytes, formatTime } from "@/lib/utils"
import { BucketHealthCard } from "@/components/bucket-health"
import { Button } from "@/components/ui/button"
import { NumberPagination } from "@/components/number-pagination"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const PAGE_SIZE = 20

/**
 * 单个桶的对象浏览区块：输入 prefix / 文件名 → 点搜索 → 展示对象列表。
 * 支持上一页 / 下一页、重命名（改完整 key）、上传到当前桶。
 */
export function BucketBrowserSection({
  title,
  bucketId,
  defaultPrefix,
  bucketName,
  bucketKey,
  health,
}: {
  title: string
  bucketId: number
  defaultPrefix: string
  /** 桶显示名与真实桶名（标题 hover 健康详情卡用）。 */
  bucketName?: string
  bucketKey?: string
  health?: BucketHealthEntry
}) {
  const [prefix, setPrefix] = React.useState(defaultPrefix)
  const [query, setQuery] = React.useState("")
  const [objects, setObjects] = React.useState<BucketObject[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [searchedPrefix, setSearchedPrefix] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)

  const [renaming, setRenaming] = React.useState<BucketObject | null>(null)
  const [uploadOpen, setUploadOpen] = React.useState(false)
  const [moveOpen, setMoveOpen] = React.useState(false)
  const [deletingKey, setDeletingKey] = React.useState<string | null>(null)
  const [busyDelete, setBusyDelete] = React.useState(false)
  const [downloadingKey, setDownloadingKey] = React.useState<string | null>(null)
  const [confirm, confirmDialog] = useConfirm()

  /** 下载到服务器：缺省目标路径 = SERVER_FILE_ROOT/<对象文件名>。 */
  const handleServerDownload = async (obj: BucketObject) => {
    setDownloadingKey(obj.key)
    try {
      const r = await serverDownload(obj.key, undefined, bucketId)
      toast.success(r.message)
    } catch (e) {
      toast.error("下载失败", { description: (e as Error).message })
    } finally {
      setDownloadingKey(null)
    }
  }

  const handleDelete = async (obj: BucketObject) => {
    if (!await confirm({
      title: "删除桶对象",
      description: `删除后不可恢复。`,
      confirmText: "删除",
      destructive: true,
    })) return
    setDeletingKey(obj.key)
    setBusyDelete(true)
    try {
      await deleteObject(obj.key, bucketId)
      toast.success("已删除", { description: obj.key })
      fetchPage(page)
    } catch (e) {
      toast.error("删除失败", { description: (e as Error).message })
    } finally {
      setDeletingKey(null)
      setBusyDelete(false)
    }
  }

  const fetchPage = React.useCallback(
    async (p: number, opts?: { prefix?: string; q?: string }) => {
      const usePrefix = opts?.prefix ?? prefix
      const useQ = opts?.q ?? query
      setLoading(true)
      try {
        const data = await getObjects(usePrefix, bucketId, p, PAGE_SIZE, useQ || undefined)
        setObjects(data.objects)
        setSearchedPrefix(data.prefix)
        setPage(data.page)
        setTotal(data.total)
      } catch (e) {
        toast.error("查询失败", { description: (e as Error).message })
      } finally {
        setLoading(false)
      }
    },
    [prefix, bucketId, query],
  )

  const search = () => fetchPage(1)

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") search()
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Cloud className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
        {bucketName && bucketKey && (
          <HoverCard openDelay={250} closeDelay={100}>
            <HoverCardTrigger asChild>
              <button
                type="button"
                title="悬停查看桶连通性详情"
                className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Info className="size-3.5" />
              </button>
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-72">
              <BucketHealthCard name={bucketName} bucketName={bucketKey} entry={health ?? null} />
            </HoverCardContent>
          </HoverCard>
        )}
        {objects !== null && <Badge variant="secondary">共 {total} 个</Badge>}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => setMoveOpen(true)}
        >
          <ArrowRightLeft className="size-3.5" />
          <span className="hidden sm:inline">移动文件</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setUploadOpen(true)}
        >
          <Upload className="size-3.5" />
          <span className="hidden sm:inline">上传到桶</span>
        </Button>
      </div>

      {/* prefix + 文件名 输入 + 搜索按钮 */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <Input
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="目录/前缀"
          className="w-full font-mono text-sm sm:w-[10rem]"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="文件名筛选，空格分隔多词"
          className="min-w-0 flex-1 text-sm"
        />
        <Button size="sm" onClick={search} disabled={loading} className="sm:ml-0">
          <Search className="size-3.5" />
          搜索
        </Button>
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>对象 Key</TableHead>
              <TableHead className="text-right">大小</TableHead>
              <TableHead className="text-right whitespace-nowrap">修改时间</TableHead>
              <TableHead className="w-12 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {objects === null ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  输入前缀或文件名后点击「搜索」查看桶内对象。
                </TableCell>
              </TableRow>
            ) : loading ? (
              <TableRow>
                <TableCell colSpan={4}>
                  <div className="h-4 w-full animate-pulse rounded bg-muted" />
                </TableCell>
              </TableRow>
            ) : objects.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  {searchedPrefix ? `「${searchedPrefix}」下没有匹配对象` : "没有匹配对象"}
                </TableCell>
              </TableRow>
            ) : (
              objects.map((obj) => (
                <TableRow key={obj.key}>
                  <TableCell>
                    <span
                      className="block max-w-[11rem] truncate font-mono text-xs sm:max-w-[24rem]"
                      title={obj.key}
                    >
                      {obj.key}
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground whitespace-nowrap">
                    {formatBytes(obj.size)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground whitespace-nowrap text-xs">
                    {formatTime(obj.last_modified)}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            title="更多操作"
                            className="inline-flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <MoreVertical className="size-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setRenaming(obj)}>
                            <Pencil className="size-3.5" /> 重命名
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleServerDownload(obj)}
                            disabled={downloadingKey !== null}
                          >
                            {downloadingKey === obj.key ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Download className="size-3.5" />
                            )}
                            下载
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => handleDelete(obj)}
                            disabled={busyDelete && deletingKey === obj.key}
                          >
                            {busyDelete && deletingKey === obj.key ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                            删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* 分页：数字分页条 */}
      {objects !== null && total > 0 && (
        <div className="border-t px-4 py-2">
          <NumberPagination
            page={page}
            pageCount={totalPages}
            total={total}
            onPageChange={(p) => fetchPage(p)}
          />
        </div>
      )}

      {/* 重命名 Dialog */}
      {renaming && (
        <RenameDialog
          obj={renaming}
          bucketId={bucketId}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null)
            fetchPage(page)
          }}
        />
      )}

      {/* 上传到桶 Dialog */}
      {uploadOpen && (
        <BucketUploadDialog
          bucketId={bucketId}
          bucketLabel={title}
          defaultPrefix={prefix}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false)
            fetchPage(1)
          }}
        />
      )}

      {/* 移动文件 Dialog */}
      {moveOpen && (
        <MoveObjectDialog
          bucketId={bucketId}
          bucketLabel={title}
          defaultPrefix={prefix}
          onClose={() => setMoveOpen(false)}
          onDone={() => {
            setMoveOpen(false)
            fetchPage(1)
          }}
        />
      )}

      {confirmDialog}
    </section>
  )
}

/** 重命名 Dialog：可修改完整 key（含前缀）。 */
function RenameDialog({
  obj,
  bucketId,
  onClose,
  onDone,
}: {
  obj: BucketObject
  bucketId: number
  onClose: () => void
  onDone: () => void
}) {
  const [newKey, setNewKey] = React.useState(obj.key)
  const [busy, setBusy] = React.useState(false)
  /** 提交后（attempted）才展示校验结果，避免打开弹窗即满屏红色。 */
  const [attempted, setAttempted] = React.useState(false)

  const keyErrorRaw = validateKey(newKey)
  const hasError = !!keyErrorRaw
  const keyError = attempted ? keyErrorRaw : null

  const submit = async () => {
    if (hasError) {
      setAttempted(true)
      return
    }
    const trimmed = newKey.trim().replace(/^\/+/, "")
    if (!trimmed) return
    if (trimmed === obj.key) {
      toast.error("新名称与原名称相同")
      return
    }
    setBusy(true)
    try {
      await renameObject(obj.key, trimmed, bucketId)
      toast.success("已重命名", { description: `${obj.key} → ${trimmed}` })
      onDone()
    } catch (e) {
      toast.error("重命名失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名对象</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="rename-key">完整对象路径（可修改前缀和文件名）</Label>
          <Input
            id="rename-key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
            className={cn("font-mono text-sm", keyError && "border-destructive focus-visible:ring-destructive")}
            autoFocus
          />
          {keyError ? (
            <p className="text-xs text-destructive">{keyError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              将通过「复制 + 删除」实现重命名，大文件可能耗时较长。
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "重命名中…" : "确认"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 校验桶内目标路径：非空、无 '..' 路径穿越。 */
function validateKey(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return "路径不能为空"
  const parts = trimmed.replace(/\\/g, "/").split("/")
  if (parts.some((p) => p === "..")) return "路径不能包含 '..'"
  return null
}

/** 移动文件 Dialog：输入原始 key 与新 key（copy + delete 实现，同桶内移动/改名）。 */
function MoveObjectDialog({
  bucketId,
  bucketLabel,
  defaultPrefix,
  onClose,
  onDone,
}: {
  bucketId: number
  bucketLabel: string
  defaultPrefix: string
  onClose: () => void
  onDone: () => void
}) {
  const cleanPrefix = defaultPrefix.replace(/^\/+|\/+$/g, "")
  const [fromKey, setFromKey] = React.useState(cleanPrefix ? `${cleanPrefix}/` : "")
  const [toKey, setToKey] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  /** 提交后（attempted）才展示校验结果，避免打开弹窗即满屏红色。 */
  const [attempted, setAttempted] = React.useState(false)

  const fromErrorRaw = validateKey(fromKey)
  const toErrorRaw = validateKey(toKey)
  const sameErrorRaw =
    fromKey.trim() && toKey.trim() && fromKey.trim() === toKey.trim()
      ? "新 key 与原始 key 相同"
      : null
  const hasError = !!fromErrorRaw || !!toErrorRaw || !!sameErrorRaw
  const fromError = attempted ? fromErrorRaw : null
  const toError = attempted ? toErrorRaw : null
  const sameError = attempted ? sameErrorRaw : null

  const submit = async () => {
    if (hasError) {
      setAttempted(true)
      return
    }
    const from = fromKey.trim().replace(/^\/+/, "")
    const to = toKey.trim().replace(/^\/+/, "")
    setBusy(true)
    try {
      await renameObject(from, to, bucketId)
      toast.success("移动成功", { description: `${from} → ${to}` })
      onDone()
    } catch (e) {
      toast.error("移动失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>移动文件（{bucketLabel}）</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="move-from">原始 Key</Label>
            <Input
              id="move-from"
              placeholder="如 opus5/a.zip"
              value={fromKey}
              onChange={(e) => setFromKey(e.target.value)}
              className={cn("font-mono text-sm", fromError && "border-destructive focus-visible:ring-destructive")}
              autoFocus
            />
            {fromError && <p className="text-xs text-destructive">{fromError}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="move-to">新 Key（目录 + 文件名）</Label>
            <Input
              id="move-to"
              placeholder="如 fable/a.zip"
              value={toKey}
              onChange={(e) => setToKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
              className={cn("font-mono text-sm", (toError || sameError) && "border-destructive focus-visible:ring-destructive")}
            />
            {toError || sameError ? (
              <p className="text-xs text-destructive">{toError ?? sameError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                通过「复制 + 删除」实现移动，大文件可能耗时较长；新 key 可只改目录（移动）或同时改名。
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "移动中…" : "移动"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 上传到桶 Dialog：选择本地文件 + 输入桶内目标路径（可快捷填入 prefix）。 */
function BucketUploadDialog({
  bucketId,
  bucketLabel,
  defaultPrefix,
  onClose,
  onDone,
}: {
  bucketId: number
  bucketLabel: string
  defaultPrefix: string
  onClose: () => void
  onDone: () => void
}) {
  const [file, setFile] = React.useState<File | null>(null)
  const [targetPath, setTargetPath] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  /** 提交后（attempted）才展示校验结果，避免打开弹窗即满屏红色。 */
  const [attempted, setAttempted] = React.useState(false)

  const pathErrorRaw = validateKey(targetPath)
  const hasError = !!pathErrorRaw
  const pathError = attempted ? pathErrorRaw : null

  // 选定文件后，默认填入 prefix/文件名
  const onFileChange = (f: File | null) => {
    setFile(f)
    if (f) {
      const parts = [defaultPrefix.replace(/\/+$/, ""), f.name].filter(Boolean)
      setTargetPath(parts.join("/"))
    }
  }

  const submit = async () => {
    if (!file || hasError) {
      setAttempted(true)
      return
    }
    const key = targetPath.trim().replace(/^\/+/, "")
    setBusy(true)
    try {
      const r = await uploadFile(file, { key, bucket: bucketId })
      toast.success(r.message)
      onDone()
    } catch (e) {
      toast.error("上传失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v && !busy) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>上传文件到{bucketLabel}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="bucket-upload-file">选择本地文件</Label>
            <Input
              id="bucket-upload-file"
              type="file"
              onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
            />
            {attempted && !file && (
              <p className="text-xs text-destructive">请选择要上传的文件</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="bucket-upload-path">桶内目标路径</Label>
            <Input
              id="bucket-upload-path"
              placeholder="如 files/photo.jpg"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
              className={cn("font-mono text-sm", pathError && "border-destructive focus-visible:ring-destructive")}
            />
            {pathError ? (
              <p className="text-xs text-destructive">{pathError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                完整路径（含前缀）；已自动填入当前前缀 + 文件名，可自行修改。
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? "提交中…" : "上传"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
