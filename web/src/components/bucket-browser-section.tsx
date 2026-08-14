import * as React from "react"
import { ChevronLeft, ChevronRight, Cloud, Download, Pencil, Search, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { type BucketObject } from "@/lib/types"
import { deleteObject, downloadUrl, getObjects, renameObject, uploadFile } from "@/lib/api"
import { useConfirm } from "@/lib/use-confirm"
import { cn, formatBytes, formatTime } from "@/lib/utils"
import { Button } from "@/components/ui/button"
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
  bucket,
  defaultPrefix,
}: {
  title: string
  bucket: "self" | "beijing" | "bucket2"
  defaultPrefix: string
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
  const [deletingKey, setDeletingKey] = React.useState<string | null>(null)
  const [busyDelete, setBusyDelete] = React.useState(false)
  const [confirm, confirmDialog] = useConfirm()

  const handleDelete = async (obj: BucketObject) => {
    if (!await confirm({
      title: "删除桶对象",
      description: `确认删除 ${obj.key}？此操作不可撤销。`,
      confirmText: "删除",
      destructive: true,
    })) return
    setDeletingKey(obj.key)
    setBusyDelete(true)
    try {
      await deleteObject(obj.key, bucket)
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
        const data = await getObjects(usePrefix, bucket, p, PAGE_SIZE, useQ || undefined)
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
    [prefix, bucket, query],
  )

  const search = () => fetchPage(1)

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") search()
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hasPrev = page > 1
  const hasNext = page < totalPages

  return (
    <section className="flex min-w-0 flex-1 flex-col rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Cloud className="size-4 text-muted-foreground" />
        <h2 className="text-base font-semibold">{title}</h2>
        {objects !== null && <Badge variant="secondary">共 {total} 个</Badge>}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => setUploadOpen(true)}
        >
          <Upload className="size-3.5" />
          上传到桶
        </Button>
      </div>

      {/* prefix + 文件名 输入 + 搜索按钮 */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <Input
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="输入目录/前缀..."
          className="w-[10rem] font-mono text-sm"
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="文件名筛选"
          className="min-w-[14rem] flex-1 text-sm"
        />
        <Button size="sm" onClick={search} disabled={loading}>
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
              <TableHead className="text-right">操作</TableHead>
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
                      className="block max-w-[24rem] truncate font-mono text-xs"
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
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        title="重命名"
                        onClick={() => setRenaming(obj)}
                      >
                        <Pencil className="size-3.5" /> 重命名
                      </Button>
                      <Button asChild variant="ghost" size="sm" title="下载">
                        <a href={downloadUrl(obj.key, bucket)}>
                          <Download className="size-3.5" /> 下载
                        </a>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="删除"
                        onClick={() => handleDelete(obj)}
                        disabled={busyDelete && deletingKey === obj.key}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" /> 删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* 分页：上一页 / 下一页 */}
      {objects !== null && total > 0 && (
        <div className="flex items-center justify-center gap-3 border-t px-4 py-2.5 text-sm text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            disabled={!hasPrev || loading}
            onClick={() => fetchPage(page - 1)}
          >
            <ChevronLeft className="size-4" />
            上一页
          </Button>
          <span className="tabular-nums">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext || loading}
            onClick={() => fetchPage(page + 1)}
          >
            下一页
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      {/* 重命名 Dialog */}
      {renaming && (
        <RenameDialog
          obj={renaming}
          bucket={bucket}
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
          bucket={bucket}
          bucketLabel={title}
          defaultPrefix={prefix}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false)
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
  bucket,
  onClose,
  onDone,
}: {
  obj: BucketObject
  bucket: "self" | "beijing" | "bucket2"
  onClose: () => void
  onDone: () => void
}) {
  const [newKey, setNewKey] = React.useState(obj.key)
  const [busy, setBusy] = React.useState(false)

  const keyError = validateKey(newKey)
  const hasError = !!keyError

  const submit = async () => {
    if (hasError) return
    const trimmed = newKey.trim().replace(/^\/+/, "")
    if (!trimmed) return
    if (trimmed === obj.key) {
      toast.error("新名称与原名称相同")
      return
    }
    setBusy(true)
    try {
      await renameObject(obj.key, trimmed, bucket)
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
            onKeyDown={(e) => e.key === "Enter" && !hasError && submit()}
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
          <Button onClick={submit} disabled={busy || hasError}>
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

/** 上传到桶 Dialog：选择本地文件 + 输入桶内目标路径（可快捷填入 prefix）。 */
function BucketUploadDialog({
  bucket,
  bucketLabel,
  defaultPrefix,
  onClose,
  onDone,
}: {
  bucket: "self" | "beijing" | "bucket2"
  bucketLabel: string
  defaultPrefix: string
  onClose: () => void
  onDone: () => void
}) {
  const [file, setFile] = React.useState<File | null>(null)
  const [targetPath, setTargetPath] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const pathError = validateKey(targetPath)
  const hasError = !!pathError

  // 选定文件后，默认填入 prefix/文件名
  const onFileChange = (f: File | null) => {
    setFile(f)
    if (f) {
      const parts = [defaultPrefix.replace(/\/+$/, ""), f.name].filter(Boolean)
      setTargetPath(parts.join("/"))
    }
  }

  const submit = async () => {
    if (!file || hasError) return
    const key = targetPath.trim().replace(/^\/+/, "")
    setBusy(true)
    try {
      const r = await uploadFile(file, { key, bucket })
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
          </div>
          <div className="space-y-2">
            <Label htmlFor="bucket-upload-path">桶内目标路径</Label>
            <Input
              id="bucket-upload-path"
              placeholder="如 files/photo.jpg"
              value={targetPath}
              onChange={(e) => setTargetPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !hasError && submit()}
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
          <Button onClick={submit} disabled={busy || !file || hasError}>
            {busy ? "提交中…" : "上传"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
