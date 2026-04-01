import { defineConfig } from "tsup";
import { writeFileSync, readFileSync, chmodSync } from "fs";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  onSuccess: async () => {
    // Add shebang to CLI entry point
    const cliPath = "dist/cli.js";
    const content = readFileSync(cliPath, "utf-8");
    if (!content.startsWith("#!")) {
      writeFileSync(cliPath, `#!/usr/bin/env node\n${content}`);
    }
    chmodSync(cliPath, 0o755);
  },
});
