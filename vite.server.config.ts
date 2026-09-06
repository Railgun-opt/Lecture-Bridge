import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "server/index.ts",
    outDir: "dist-app-server",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "index.mjs",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
