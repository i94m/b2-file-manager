import * as React from "react"
import { Link2, Upload, Server } from "lucide-react"
import { toast } from "sonner"

import { type Datasource } from "@/lib/types"
import { uploadFile, urlUpload, serverDownload } from "@/lib/api"
import { useBuckets } from "@/lib/use-buckets"
import { addPrefix, getLastPrefix, validatePrefix } from "@/lib/prefix"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PrefixInput } from "@/components/prefix-input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface CommonProps {
  defaultPrefix: string
  scripts: Datasource[]
  onDone: () => void
}

/**
 * prefix 输入：初始值优先取 localStorage 历史，其次后端 .env 默认值。
 * 用户手动输入后不再覆盖（解决 defaultPrefix 异步加载覆盖输入的问题）。
 */
function usePrefix(defaultPrefix: string) {
  const [prefix, setPrefix] = React.useState(() => getLastPrefix() || defaultPrefix)
  const dirty = React.useRef(false)
  React.useEffect(() => {
    if (!dirty.current && defaultPrefix) {
      setPrefix(getLastPrefix() || defaultPrefix)
    }
  }, [defaultPrefix])
  const onChange = React.useCallback((v: string) => {
    dirty.current = true
    setPrefix(v)
  }, [])
  return { prefix, setPrefix: onChange } as const
}

/** 录入待处理文件 Dialog（链接或任意标识，登记到文件库）。 */
export function FetchUrlDialog({ defaultPrefix, scripts, onDone }: CommonProps) {
  const [open, setOpen] = React.useState(false)
  const [url, setUrl] = React.useState("")
  const { prefix, setPrefix } = usePrefix(defaultPrefix)
  const [datasourceId, setDatasourceId] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const prefixValid = validatePrefix(prefix).valid
  const urlFilename = React.useMemo(() => {
    const t = url.trim()
    if (!t) return undefined
    return t.split(/[\\/]/).filter(Boolean).pop() ?? t
  }, [url])

  const submit = async () => {
    if (!url.trim()) return
    const normalized = validatePrefix(prefix).normalized
    setBusy(true)
    try {
      const r = await urlUpload(url.trim(), {
        prefix: normalized || undefined,
        datasourceId: datasourceId ? Number(datasourceId) : undefined,
      })
      toast(r.message)
      if (normalized) addPrefix(normalized)
      setUrl("")
      setOpen(false)
      onDone()
    } catch (e) {
      toast.error("录入失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default">
          <Link2 className="size-4" /> 录入待处理文件
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>录入待处理文件</DialogTitle>
          <DialogDescription>
            登记下载链接或任意文件标识到文件库，稍后在列表手动触发上传。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="fetch-url">链接 / 标识</Label>
            <Input
              id="fetch-url"
              placeholder="下载链接、文件名或任意标识"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </div>
          <div className="grid grid-cols-[1fr_200px] items-start gap-3">
            <div className="space-y-2">
              <Label htmlFor="fetch-dir">目录（可选）</Label>
              <PrefixInput
                value={prefix}
                onChange={setPrefix}
                filename={urlFilename}
              />
            </div>
            <div className="space-y-2">
              <Label>数据源（可选）</Label>
              <Select value={datasourceId} onValueChange={setDatasourceId}>
                <SelectTrigger>
                  <SelectValue placeholder="不关联" />
                </SelectTrigger>
                <SelectContent>
                  {scripts.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !url.trim() || !prefixValid}>
            {busy ? "提交中…" : "录入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 上传文件 Dialog。 */
export function UploadDialog({ defaultPrefix, scripts, onDone }: CommonProps) {
  const { buckets } = useBuckets()
  const enabledBuckets = buckets.filter((b) => b.enabled)
  const defaultBucket = enabledBuckets.find((b) => b.is_default) ?? enabledBuckets[0]
  const [bucketId, setBucketId] = React.useState("")
  React.useEffect(() => {
    if (!bucketId && defaultBucket) setBucketId(String(defaultBucket.id))
  }, [bucketId, defaultBucket])

  const [open, setOpen] = React.useState(false)
  const [file, setFile] = React.useState<File | null>(null)
  const { prefix, setPrefix } = usePrefix(defaultPrefix)
  const [datasourceId, setDatasourceId] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const prefixValid = validatePrefix(prefix).valid

  const submit = async () => {
    if (!file) return
    const normalized = validatePrefix(prefix).normalized
    setBusy(true)
    try {
      const r = await uploadFile(file, {
        prefix: normalized || undefined,
        bucket: bucketId ? Number(bucketId) : undefined,
        datasourceId: datasourceId ? Number(datasourceId) : undefined,
      })
      toast.success(r.message)
      if (normalized) addPrefix(normalized)
      setFile(null)
      setOpen(false)
      onDone()
    } catch (e) {
      toast.error("上传失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="size-4" /> 上传文件
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>上传本地文件</DialogTitle>
          <DialogDescription>文件先落盘服务器，再后台队列上传到 Bucket。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="upload-file">选择文件</Label>
            <Input
              id="upload-file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="upload-prefix">目录（可选）</Label>
              <PrefixInput
                value={prefix}
                onChange={setPrefix}
                filename={file?.name}
              />
            </div>
            <div className="space-y-2">
              <Label>上传到桶</Label>
              <Select value={bucketId} onValueChange={setBucketId}>
                <SelectTrigger>
                  <SelectValue placeholder={enabledBuckets.length ? "默认桶" : "暂无可用桶"} />
                </SelectTrigger>
                <SelectContent>
                  {enabledBuckets.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>数据源（可选）</Label>
            <Select value={datasourceId} onValueChange={setDatasourceId}>
              <SelectTrigger>
                <SelectValue placeholder="不关联" />
              </SelectTrigger>
              <SelectContent>
                {scripts.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !file || !prefixValid}>
            {busy ? "上传中…" : "上传"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 下载对象到服务器 Dialog（半成品搬运：从 bucket 拉到 SERVER_FILE_ROOT）。 */
export function DownloadDialog({ onDone }: { onDone: () => void }) {
  const { buckets } = useBuckets()
  const enabledBuckets = buckets.filter((b) => b.enabled)
  const defaultBucket = enabledBuckets.find((b) => b.is_default) ?? enabledBuckets[0]
  const [bucketId, setBucketId] = React.useState("")
  React.useEffect(() => {
    if (!bucketId && defaultBucket) setBucketId(String(defaultBucket.id))
  }, [bucketId, defaultBucket])

  const [open, setOpen] = React.useState(false)
  const [key, setKey] = React.useState("")
  const [destination, setDestination] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  const submit = async () => {
    if (!key.trim()) return
    setBusy(true)
    try {
      const r = await serverDownload(
        key.trim(),
        destination.trim() || undefined,
        bucketId ? Number(bucketId) : "self",
      )
      toast.success(r.message)
      setKey("")
      setDestination("")
      setOpen(false)
      onDone()
    } catch (e) {
      toast.error("下载失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Server className="size-4" /> 下载到服务器
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>下载 Bucket 对象到服务器</DialogTitle>
          <DialogDescription>
            将对象流式下载到 SERVER_FILE_ROOT 内的目标路径（后台队列处理）。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>来源桶</Label>
            <Select value={bucketId} onValueChange={setBucketId}>
              <SelectTrigger>
                <SelectValue placeholder={enabledBuckets.length ? "默认桶" : "暂无可用桶"} />
              </SelectTrigger>
              <SelectContent>
                {enabledBuckets.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dl-key">对象名 (key)</Label>
            <Input
              id="dl-key"
              placeholder="uuid-filename.ext"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dl-dest">目标路径（可选）</Label>
            <Input
              id="dl-dest"
              placeholder="留空 = SERVER_FILE_ROOT/文件名"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !key.trim()}>
            {busy ? "提交中…" : "下载"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
