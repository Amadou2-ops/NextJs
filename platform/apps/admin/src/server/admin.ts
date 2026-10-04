import "server-only";

import { cache } from "react";

import type { CurrentAdmin, Permission } from "@/lib/types";

import { sessionApi } from "./context";

/**
 * Membre connecté, ses rôles et permissions effectives, lus auprès de l'API
 * une fois par rendu. L'interface masque ce que le membre ne peut pas faire ;
 * l'API et la base revérifient chaque permission à chaque appel.
 */
export const currentAdmin = cache((): Promise<CurrentAdmin> => sessionApi<CurrentAdmin>("/", { path: "/v1/admin/me" }));

export function can(admin: CurrentAdmin, permission: Permission): boolean {
  return admin.permissions.includes(permission);
}

/** Action soumise à la double validation pour ce membre ? */
export function requiresFourEyes(admin: CurrentAdmin, permission: Permission): boolean {
  return admin.fourEyesPermissions.includes(permission);
}
