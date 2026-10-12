import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Prevent vite from obscuring Rust errors
  clearScreen: false,
  server: {
    // Tauri expects a fixed port; fail if that port is not available
    strictPort: true,
    // Expose to LAN if TAURI_DEV_HOST is set
    host: host || false,
    port: 1420,
    watch: {
      // Tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
