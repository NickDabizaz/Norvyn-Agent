import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "es2022",
  clean: false,
  esbuildOptions(options) {
    options.banner = { js: "#!/usr/bin/env node" };
  },
});
