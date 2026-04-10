import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { wikiraceDevPlugin } from "./wikiraceDevPlugin";

export default defineConfig({
  plugins: [react(), wikiraceDevPlugin()],
  server: {
    port: 5173,
  },
});
