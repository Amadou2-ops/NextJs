"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { apiRequest } from "@/server/api";
import { clearCookie, clientContext, readSession, transport } from "@/server/context";
import { PENDING_COOKIE, SESSION_COOKIE } from "@/server/session";

/** Déconnexion : révocation de la session côté API, puis effacement des cookies. */
export async function logoutAction(): Promise<void> {
  const session = await readSession();
  if (session !== null) {
    try {
      await apiRequest(transport(), { method: "POST", path: "/v1/admin/auth/logout", accessToken: session.accessToken, context: await clientContext() });
    } catch {
      // Jeton expiré ou API indisponible : la session expirera d'elle-même (inactivité).
    }
  }
  const store = await cookies();
  clearCookie(store, SESSION_COOKIE);
  clearCookie(store, PENDING_COOKIE);
  redirect("/connexion");
}
