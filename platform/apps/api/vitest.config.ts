import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/support/globalSetup.ts"],
    // Les tests d'intégration partagent une base PostgreSQL : exécution en série
    // des fichiers pour des résultats déterministes.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
