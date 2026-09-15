/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `flowlab serve` runs the API on 127.0.0.1:8765; in dev, Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8765", ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 6000,
  },
  test: {
    environment: "node",
  },
});
