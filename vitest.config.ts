import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@rally/domain": r("./packages/domain/src/index.ts"),
      "@rally/simulation": r("./packages/simulation/src/index.ts"),
      "@rally/data-gen": r("./packages/data-gen/src/index.ts"),
      "@rally/importers": r("./packages/importers/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
  },
});
