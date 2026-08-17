import { cn } from "@/lib/utils"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"

/** 生成带省略号的页码窗口：首页/末页恒显，中间当前页 ±1，其余折叠为 …。
 *  例：page=1,total=20 → 1 2 … 20；page=10 → 1 … 9 10 11 … 20。 */
export function pageWindow(page: number, totalPages: number): (number | "…")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const pages = new Set<number>([1, 2, totalPages - 1, totalPages, page - 1, page, page + 1])
  const list: (number | "…")[] = []
  let prev = 0
  for (let i = 1; i <= totalPages; i++) {
    if (!pages.has(i)) continue
    if (prev && i - prev > 1) list.push("…")
    list.push(i)
    prev = i
  }
  return list
}

/** 数字分页条：统计信息（左）+ 页码（右），单行布局。 */
export function NumberPagination({
  page,
  pageCount,
  total,
  onPageChange,
  className,
}: {
  page: number
  pageCount: number
  /** 总条数（展示「共 N 条」）；不传则只显示页码。 */
  total?: number
  onPageChange: (page: number) => void
  className?: string
}) {
  const items = pageWindow(page, pageCount)
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-2 gap-y-1", className)}>
      {total !== undefined && (
        <p className="shrink-0 text-xs text-muted-foreground sm:text-sm">
          共 <span className="font-medium text-foreground">{total}</span> 条 ·
          第 {page} / {pageCount} 页
        </p>
      )}
      <Pagination className="mx-0 w-auto justify-end min-w-0">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              aria-disabled={page <= 1}
              className={cn("gap-0 px-2", page <= 1 && "pointer-events-none opacity-50")}
              onClick={(e) => {
                e.preventDefault()
                if (page > 1) onPageChange(page - 1)
              }}
            />
          </PaginationItem>
          {items.map((it, idx) =>
            it === "…" ? (
              <PaginationItem key={`e-${idx}`}>
                <PaginationEllipsis className="size-8" />
              </PaginationItem>
            ) : (
              <PaginationItem key={it}>
                <PaginationLink
                  href="#"
                  isActive={it === page}
                  className="size-8"
                  onClick={(e) => {
                    e.preventDefault()
                    onPageChange(it)
                  }}
                >
                  {it}
                </PaginationLink>
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            <PaginationNext
              href="#"
              aria-disabled={page >= pageCount}
              className={cn("gap-0 px-2", page >= pageCount && "pointer-events-none opacity-50")}
              onClick={(e) => {
                e.preventDefault()
                if (page < pageCount) onPageChange(page + 1)
              }}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
