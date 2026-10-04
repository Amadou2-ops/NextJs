import { createFullApplication, routesOf } from "./fullApplication.js";

/** Liste (méthode, chemin) des routes des modules montés par l'API. */
export async function routesForContract(): Promise<readonly { readonly method: string; readonly path: string }[]> {
  const full = await createFullApplication();
  try {
    return routesOf(full.routers);
  } finally {
    await full.close();
  }
}
