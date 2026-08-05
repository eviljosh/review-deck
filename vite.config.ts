// The server reads PORT via dotenv, so load .env here too — otherwise a PORT
// set in .env would move the API without the proxy following it.
import "dotenv/config";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = Number(process.env.PORT ?? 3001);

export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  server: {
    port: Number(process.env.UI_PORT ?? 3000),
    proxy: {
      "^/api/": `http://localhost:${apiPort}`,
      "^/ws$": { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
  build: { outDir: "../../dist/ui", emptyOutDir: true },
});
