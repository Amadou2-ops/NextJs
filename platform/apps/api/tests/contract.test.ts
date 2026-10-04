import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { ERROR_CODES } from "../src/lib/errors.js";
import { routesForContract } from "./support/contract.js";

/**
 * Le contrat OpenAPI partagé (mobile, web, admin) doit lister exactement les
 * codes d'erreur que l'API peut renvoyer.
 */
interface OpenApiDocument {
  readonly openapi: string;
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

describe("contrat OpenAPI", () => {
  it("est un document OpenAPI 3.1 valide dont toutes les références existent", () => {
    const raw = readFileSync(fileURLToPath(new URL("../../../packages/contracts/openapi.yaml", import.meta.url)), "utf8");
    const document = parse(raw) as OpenApiDocument;
    expect(document.openapi).toBe("3.1.0");
    for (const [, kind, name] of raw.matchAll(/#\/components\/(\w+)\/(\w+)/g)) {
      expect(document.components[kind ?? ""]?.[name ?? ""], `référence #/components/${kind ?? ""}/${name ?? ""} introuvable`).toBeDefined();
    }
  });

  it("déclare exactement les codes d'erreur de l'API", () => {
    const contract = readFileSync(fileURLToPath(new URL("../../../packages/contracts/openapi.yaml", import.meta.url)), "utf8");
    const block = / {4}ErrorCode:\n[\s\S]*? {6}enum:\n((?: {8}- [A-Z_]+\n)+)/.exec(contract);
    expect(block).not.toBeNull();
    const declared = [...(block?.[1] ?? "").matchAll(/- ([A-Z_]+)/g)].map((match) => match[1]);
    expect(declared).toEqual([...ERROR_CODES]);
  });

  it("documente chaque route des modules montés", async () => {
    const contract = readFileSync(fileURLToPath(new URL("../../../packages/contracts/openapi.yaml", import.meta.url)), "utf8");
    const routes = await routesForContract();
    expect(routes.length).toBeGreaterThan(25);
    for (const route of routes) {
      const openApiPath = route.path.replace(/^\/v1/, "").replace(/:([A-Za-z]+)/g, "{$1}");
      const block = new RegExp(`\\n  ${openApiPath.replace(/[{}/]/g, "\\$&")}:\\n((?:    .*\\n|      .*\\n)+)`).exec(contract);
      expect(block, `chemin ${openApiPath} absent du contrat`).not.toBeNull();
      expect(block?.[1], `${route.method} ${openApiPath} absent du contrat`).toMatch(new RegExp(`^    ${route.method}:`, "m"));
    }
  });
});
