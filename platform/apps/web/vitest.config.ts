import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Garde-fou « server-only » neutralisé hors de Next.js (tests unitaires du BFF).
      "server-only": fileURLToPath(new URL("./tests/support/serverOnly.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
