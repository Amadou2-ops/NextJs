import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../src/lib/errors.js";

/**
 * Le contrat OpenAPI partagé (mobile, web, admin) doit lister exactement les
 * codes d'erreur que l'API peut renvoyer.
 */
describe("contrat OpenAPI", () => {
  it("déclare exactement les codes d'erreur de l'API", () => {
    const contract = readFileSync(fileURLToPath(new URL("../../../packages/contracts/openapi.yaml", import.meta.url)), "utf8");
    const block = / {4}ErrorCode:\n[\s\S]*? {6}enum:\n((?: {8}- [A-Z_]+\n)+)/.exec(contract);
    expect(block).not.toBeNull();
    const declared = [...(block?.[1] ?? "").matchAll(/- ([A-Z_]+)/g)].map((match) => match[1]);
    expect(declared).toEqual([...ERROR_CODES]);
  });
});
