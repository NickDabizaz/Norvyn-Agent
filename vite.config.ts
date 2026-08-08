import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    exclude: ["test/browser/**", "**/node_modules/**", "**/dist/**"],
  },
});
