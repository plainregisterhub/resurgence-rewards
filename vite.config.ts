import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Use relative asset URLs so the app loads reliably from the GitHub Pages project path.
  base: "./",
});
