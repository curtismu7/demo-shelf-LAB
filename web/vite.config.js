import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API runs on :4400 (npm run dev -w server). The page is on :4401 so it stays clear of other tools' ports.
export default defineConfig({
  plugins: [react()],
  server: { port: 4401, strictPort: true, proxy: { "/api": { target: "http://localhost:4400" } } },
  test: { environment: "jsdom", globals: true, setupFiles: "./src/testSetup.js" },
});
