import {
  IconAlertTriangleFilled,
  IconCircleCheckFilled,
  IconCircleXFilled,
  IconInfoCircleFilled,
  IconLoader2,
} from "@tabler/icons-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

// geometricPrecision:小尺寸实心图标的曲线边缘按几何精度抗锯齿渲染,避免锯齿感
const iconCls = "size-5 [shape-rendering:geometricPrecision]"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <IconCircleCheckFilled className={`${iconCls} text-emerald-500 dark:text-emerald-400`} />
        ),
        info: (
          <IconInfoCircleFilled className={`${iconCls} text-blue-500 dark:text-blue-400`} />
        ),
        warning: (
          <IconAlertTriangleFilled className={`${iconCls} text-amber-500 dark:text-amber-400`} />
        ),
        error: (
          <IconCircleXFilled className={`${iconCls} text-red-500 dark:text-red-400`} />
        ),
        loading: (
          <IconLoader2 className={`${iconCls} animate-spin text-muted-foreground`} />
        ),
      }}
      position="top-center"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          // 通用配色:所有类型统一中性卡片背景 + 中性文字,语义色只体现在图标上
          "--success-bg": "var(--popover)",
          "--success-text": "var(--popover-foreground)",
          "--error-bg": "var(--popover)",
          "--error-text": "var(--popover-foreground)",
          "--warning-bg": "var(--popover)",
          "--warning-text": "var(--popover-foreground)",
          "--info-bg": "var(--popover)",
          "--info-text": "var(--popover-foreground)",
          "--border-radius": "0.375rem",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // 无边框 + 自适应宽度(上限 480px / 移动端不贴边)+ 加深的多层阴影
          // center 模式下 sonner 只居中容器(356px)、不为 toast 设 left/right,
          // 因此必须同时钉住 !left-0 !right-0,!mx-auto 才能把 w-fit 的窄 toast 真正水平居中
          toast: "!py-2.5 !px-3.5 !text-xs !gap-1.5 !border-0 !w-fit !max-w-[min(100vw_-_2rem,30rem)] !left-0 !right-0 !mx-auto !shadow-[0_10px_32px_-8px_rgba(0,0,0,0.24),0_4px_12px_-4px_rgba(0,0,0,0.14)]",
          title: "!text-xs !font-medium",
          description: "!text-[11px]",
          success: "![background:var(--success-bg)] ![color:var(--success-text)]",
          error: "![background:var(--error-bg)] ![color:var(--error-text)]",
          warning: "![background:var(--warning-bg)] ![color:var(--warning-text)]",
          info: "![background:var(--info-bg)] ![color:var(--info-text)]",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
