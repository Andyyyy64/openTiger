import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// h1veダッシュボードのポートを固定して衝突を避ける
const dashboardPort = Number.parseInt(process.env.H1VE_DASHBOARD_PORT ?? '5190', 10)
// ダッシュボードが参照するAPIポートを環境変数で揃える
const apiPort = Number.parseInt(
  process.env.H1VE_API_PORT ?? process.env.API_PORT ?? '4301',
  10,
)

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    port: dashboardPort,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
