import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // This repository is hosted at https://<owner>.github.io/resurgence-rewards/
  base: "/resurgence-rewards/",
});
