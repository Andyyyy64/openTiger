import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Fix the openTiger dashboard port to avoid conflicts
const dashboardPort = Number.parseInt(process.env.OPENTIGER_DASHBOARD_PORT ?? "5190", 10);
// Align the API port referenced by the dashboard via environment variables
const apiPort = Number.parseInt(
  process.env.OPENTIGER_API_PORT ?? process.env.API_PORT ?? "4301",
  10,
);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: dashboardPort,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (proxyRes.headers["content-type"]?.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache";
              proxyRes.headers["connection"] = "keep-alive";
            }
          });
        },
      },
    },
  },
});
