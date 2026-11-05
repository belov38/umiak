import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
	plugins: [react()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	server: {
		host: "127.0.0.1",
		proxy: {
			"/api": { target: "http://localhost:4180", changeOrigin: true },
			"/quickstart": { target: "http://localhost:4180", changeOrigin: true },
		},
	},
	build: { outDir: "dist" },
});
