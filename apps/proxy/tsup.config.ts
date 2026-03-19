import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  target: "node22",
  splitting: true,
  clean: true,
  outDir: "dist",
  dts: { entry: "src/index.ts" },
});
