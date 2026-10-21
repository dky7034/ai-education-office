import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig(({ mode }) => {
  const standalone = mode === "standalone";
  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(standalone ? [viteSingleFile()] : []),
    ],
    server: {
      proxy: {
        "/api": { target: "http://127.0.0.1:3001", changeOrigin: false },
      },
    },
    define: { __STANDALONE__: JSON.stringify(standalone) },
    build: {
      outDir: standalone ? "../preview" : "dist",
      emptyOutDir: true,
      ...(!standalone && {
        rollupOptions: {
          output: {
            manualChunks: (id: string) =>
              id.includes("/phaser/") ? "phaser" : undefined,
          },
        },
      }),
      chunkSizeWarningLimit: 1600,
    },
  };
});
