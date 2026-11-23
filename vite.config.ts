import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [preact(), tailwindcss()],
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
