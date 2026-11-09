import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      // Robot controller WebSocket (kept on the same origin to avoid
      // mixed-content when the twin is served over HTTPS).
      "/robot-ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
      // Vision service (detect / stream / calibrate). Strip the /vision prefix.
      "/vision": {
        target: "http://localhost:8081",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/vision/, ""),
      },
    },
  },
  build: {
    target: "es2022",
  },
});
