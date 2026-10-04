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
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Points d'entrée : assemblage des modules (testés séparément) et
      // ressources de processus (signaux, connexions Redis réelles).
      exclude: ["src/server.ts", "src/worker.ts", "src/cli/**", "src/config/logger.ts", "src/lib/redis.ts", "src/types/**"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      // Seuils bloquants : toute régression de couverture fait échouer la CI.
      thresholds: { statements: 85, branches: 72, functions: 91, lines: 90 },
    },
  },
});
