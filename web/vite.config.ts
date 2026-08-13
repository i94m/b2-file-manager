import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// 后端服务地址（开发期反代目标，与生产 nginx 一致）
const backendOrigin = "http://127.0.0.1:5000"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    // 开发期把后端接口反代到 Flask（与生产 nginx 一致），
    // 前端始终用相对路径，无需 CORS。
    proxy: {
      "/api": backendOrigin,
      "/socket.io": {
        target: backendOrigin,
        ws: true,
      },
      "/download": backendOrigin,
      "/upload": backendOrigin,
      "/server-upload": backendOrigin,
      "/server-download": backendOrigin,
      "/url-upload": backendOrigin,
      "/scripts": backendOrigin,
    },
  },
})
