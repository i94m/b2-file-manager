import * as React from "react"
import { Download, FileIcon, FolderOpen, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { type ServerFile } from "@/lib/types"
import { deleteServerFile, getServerFiles, serverFileDownloadUrl } from "@/lib/api"
import { formatBytes } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/**
 * 本地文件区块：展示 SERVER_FILE_ROOT 目录里的文件列表，
 * 支持下载（服务器→浏览器）与删除，显示每个文件大小和目录总大小。
 */
export function ServerFilesSection() {
  const [files, setFiles] = React.useState<ServerFile[]>([])
  const [root, setRoot] = React.useState<string | null>(null)
  const [totalSize, setTotalSize] = React.useState(0)
  const [loading, setLoading] = React.useState(true)
  const [busyPath, setBusyPath] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const data = await getServerFiles()
      setFiles(data.files)
      setRoot(data.root)
      setTotalSize(data.total_size)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const handleDelete = async (f: ServerFile) => {
    if (!confirm(`确认删除本地文件 ${f.path}？此操作不可撤销。`)) return
    setBusyPath(f.path)
    try {
      await deleteServerFile(f.path)
      toast.success("已删除", { description: f.path })
      load()
    } catch (e) {
      toast.error("删除失败", { description: (e as Error).message })
    } finally {
      setBusyPath(null)
    }
  }

  return (
    <section className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <FolderOpen className="size-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">本地文件</h2>
          <Badge variant="secondary">
            {files.length} 个 · 共 {formatBytes(totalSize)}
          </Badge>
        </div>
        {root && (
          <code className="max-w-[40ch] truncate font-mono text-xs text-muted-foreground">
            {root}
          </code>
        )}
      </div>

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>文件</TableHead>
              <TableHead className="text-right">大小</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={3}>
                  <div className="h-4 w-full animate-pulse rounded bg-muted" />
                </TableCell>
              </TableRow>
            ) : files.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                  本地目录还没有文件。可在「下载到服务器」或录入时把文件拉到本地。
                </TableCell>
              </TableRow>
            ) : (
              files.map((f) => (
                <TableRow key={f.path}>
                  <TableCell>
                    <span className="inline-flex items-center gap-2 font-mono text-xs">
                      <FileIcon className="size-3.5 text-muted-foreground" />
                      <span title={f.path}>{f.path}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatBytes(f.size)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button asChild variant="ghost" size="sm" title="下载到电脑">
                        <a href={serverFileDownloadUrl(f.path)}>
                          <Download className="size-3.5" /> 下载
                        </a>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(f)}
                        disabled={busyPath === f.path}
                        className="text-destructive hover:text-destructive"
                        title="删除"
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
    </section>
  )
}
