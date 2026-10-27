import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  // Relative asset URLs: the server sets <base href> to the URL base, so the same build works on any sub-path.
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8484" } },
});
