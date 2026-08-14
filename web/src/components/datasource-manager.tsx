import * as React from "react"
import { Layers, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { createScript, deleteScript, updateScript } from "@/lib/api"
import type { Datasource } from "@/lib/types"
import { useConfirm } from "@/lib/use-confirm"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/** 数据源管理入口：Dialog 内表格（列表/编辑切换）。 */
export function DatasourceManager({
  scripts,
  onChanged,
}: {
  scripts: Datasource[]
  onChanged: () => void
}) {
  const [open, setOpen] = React.useState(false)
  /** null = 列表视图；{id: null} = 新增；{id: n} = 编辑。 */
  const [formTarget, setFormTarget] = React.useState<{ id: number | null } | null>(null)
  const [confirm, confirmDialog] = useConfirm()

  const handleDelete = async (s: Datasource) => {
    if (
      !(await confirm({
        title: "删除数据源",
        description: `确认删除「${s.name}」？关联文件的数据源字段会被清空。此操作不可撤销。`,
        confirmText: "删除",
        destructive: true,
      }))
    )
      return
    try {
      const r = await deleteScript(s.id)
      toast.success(r.message)
      onChanged()
    } catch (e) {
      toast.error("删除失败", { description: (e as Error).message })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setFormTarget(null)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Layers className="size-4" /> 数据源
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>数据源管理</DialogTitle>
          <DialogDescription>
            数据源用于标记文件来源；脚本路径仅作备注记录，系统不会执行。
          </DialogDescription>
        </DialogHeader>
        {formTarget ? (
          <DatasourceForm
            initial={
              formTarget.id === null ? null : scripts.find((s) => s.id === formTarget.id) ?? null
            }
            onClose={() => setFormTarget(null)}
            onSaved={() => {
              setFormTarget(null)
              onChanged()
            }}
          />
        ) : (
          <div className="space-y-3">
            <div className="max-h-[55vh] overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>脚本路径</TableHead>
                    <TableHead>描述</TableHead>
                    <TableHead className="w-12 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scripts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                        还没有数据源，点击下方「新增数据源」创建。
                      </TableCell>
                    </TableRow>
                  ) : (
                    scripts.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell
                          className="max-w-[12rem] truncate font-mono text-xs"
                          title={s.script_path ?? undefined}
                        >
                          {s.script_path ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell
                          className="max-w-[14rem] truncate text-xs text-muted-foreground"
                          title={s.description ?? undefined}
                        >
                          {s.description ?? <span className="text-muted-foreground">—</span>}
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
                                <DropdownMenuItem onClick={() => setFormTarget({ id: s.id })}>
                                  <Pencil className="size-3.5" /> 编辑
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  variant="destructive"
                                  onClick={() => handleDelete(s)}
                                >
                                  <Trash2 className="size-3.5" /> 删除
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
            <Button size="sm" onClick={() => setFormTarget({ id: null })}>
              <Plus className="size-3.5" /> 新增数据源
            </Button>
          </div>
        )}
      </DialogContent>
      {confirmDialog}
    </Dialog>
  )
}

/** 新增/编辑数据源表单。 */
function DatasourceForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Datasource | null
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!initial
  const [form, setForm] = React.useState({
    name: initial?.name ?? "",
    script_path: initial?.script_path ?? "",
    description: initial?.description ?? "",
  })
  const [busy, setBusy] = React.useState(false)

  const set = (key: keyof typeof form, value: string) =>
    setForm((f) => ({ ...f, [key]: value }))

  const nameError = form.name.trim() ? null : "名称必填"
  const hasError = !!nameError
  const inputCls = (err: string | null) =>
    cn(err && "border-destructive focus-visible:ring-destructive")

  const submit = async () => {
    if (hasError) return
    setBusy(true)
    try {
      const data = {
        name: form.name.trim(),
        script_path: form.script_path.trim(),
        description: form.description.trim(),
      }
      const r = isEdit ? await updateScript(initial.id, data) : await createScript(data)
      toast.success(r.message)
      onSaved()
    } catch (e) {
      toast.error("保存失败", { description: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="max-h-[55vh] space-y-4 overflow-y-auto py-1">
        <div className="space-y-2">
          <Label>名称</Label>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="如 爬虫A"
            className={inputCls(nameError)}
            autoFocus
          />
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
        </div>
        <div className="space-y-2">
          <Label>脚本路径（可选，仅备注不执行）</Label>
          <Input
            value={form.script_path}
            onChange={(e) => set("script_path", e.target.value)}
            placeholder="/opt/scripts/spider_a.py"
            className="font-mono text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label>描述（可选）</Label>
          <Input
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="备注信息"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose} disabled={busy}>
          取消
        </Button>
        <Button onClick={submit} disabled={busy || hasError}>
          {busy ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  )
}
