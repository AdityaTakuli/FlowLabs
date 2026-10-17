/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `base: "./"` makes one build work everywhere: served by `synapse app` / `synapse engine` at /,
// and hosted under a sub-path such as https://<user>.github.io/Synapse/.
// In dev, /api goes to a running `synapse engine --port 8899`.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8899", changeOrigin: false } },
  },
  worker: { format: "es" },
  build: { outDir: "dist", chunkSizeWarningLimit: 2000 },
  test: { environment: "node" },
});
