import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Mirrors tsconfig.json's "@/*" -> "src/*" path alias (the same one
// next.config.js/Next's own bundler resolves) so files under src/app that
// import via "@/lib/..." — matching this repo's Next-side convention — can
// be unit-tested directly with vitest, not just typechecked by tsc.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
  test: {
    // Global safety net -- see vitest.setup.ts's own header comment: no
    // test should ever be able to write to the owner's real gigradar
    // database, even incidentally.
    setupFiles: ["./vitest.setup.ts"],
  },
});
