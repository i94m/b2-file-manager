import path from "node:path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

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
    // 开发期把后端接口反代到 Flask（127.0.0.1:8000，与生产 nginx 一致），
    // 前端始终用相对路径，无需 CORS。
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/socket.io": {
        target: "http://127.0.0.1:8000",
        ws: true,
      },
      "/download": "http://127.0.0.1:8000",
      "/upload": "http://127.0.0.1:8000",
      "/server-upload": "http://127.0.0.1:8000",
      "/server-download": "http://127.0.0.1:8000",
      "/url-upload": "http://127.0.0.1:8000",
      "/scripts": "http://127.0.0.1:8000",
    },
  },
})
