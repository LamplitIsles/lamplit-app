import { svelte } from "@sveltejs/vite-plugin-svelte";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import { defineConfig } from "vite";
export default defineConfig({
  base: "/slice/",
  publicDir: "static",
  build: { outDir: "build" },
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/lib/paraglide",
      emitTsDeclarations: true,
      strategy: ["globalVariable", "preferredLanguage", "baseLocale"],
    }),
    svelte(),
  ],
  server: {
    proxy: {
      "/api": {
        target: process.env.CHAT_BACKEND ?? "http://127.0.0.1:8787",
        ws: true,
        changeOrigin: true,
        rewriteWsOrigin: true,
      },
    },
  },
});
