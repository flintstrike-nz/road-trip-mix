import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  // tsconfig keeps JSX as "preserve" for Next; tests need it compiled.
  esbuild: { jsx: "automatic" },
  test: { include: ["lib/**/*.test.ts", "scripts/**/*.test.ts", "jam-client/**/*.test.ts", "app/**/*.test.tsx"] },
});
