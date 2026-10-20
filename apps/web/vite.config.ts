import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";

// Target proxy dev; ubah lewat API_URL kalau port 3000 sudah dipakai app lain.
const API_URL = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss(), process.env.ANALYZE ? visualizer({ filename: "dist/stats.html", gzipSize: true }) : null],
  server: {
    port: 5173,
    proxy: { "/api": API_URL, "/webhooks": API_URL, "/healthz": API_URL },
  },
  build: {
    target: "es2020",
    cssCodeSplit: true,
    rollupOptions: { output: { manualChunks: { react: ["react", "react-dom"], query: ["@tanstack/react-query"] } } },
  },
});
