/**
 * `pnpm demo` : démonstration locale de la plateforme (voir support/demo.ts).
 * Par défaut, PostgreSQL et Redis du docker-compose.yml de `platform/`
 * (ports 54329 et 63799) ; E2E_POSTGRES_URL et E2E_REDIS_URL les remplacent.
 */
process.env["E2E_SUITE"] = "demo";
process.env["E2E_POSTGRES_URL"] ??= "postgres://postgres:postgres@127.0.0.1:54329";
process.env["E2E_REDIS_URL"] ??= "redis://:local-redis-password@127.0.0.1:63799/9";

await import("./stack.js");
