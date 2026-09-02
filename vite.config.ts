import { defineConfig } from "vite"

// Tauri が固定ポートを前提にするため、ポートは固定し、衝突時は失敗させる。
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: "es2022", sourcemap: true },
})
