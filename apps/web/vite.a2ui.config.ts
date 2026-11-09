import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
export default defineConfig({
  base: "/",
  publicDir: false,
  build: {
    outDir: "build",
    emptyOutDir: false,
    rollupOptions: { input: "a2ui.html" },
  },
  plugins: [tailwindcss(), svelte()],
});
