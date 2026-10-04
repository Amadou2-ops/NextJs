"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { apiRequest } from "@/server/api";
import { clearCookie, clientContext, readSession, transport } from "@/server/context";
import { PENDING_COOKIE, SESSION_COOKIE } from "@/server/session";

/** Déconnexion : révocation de la session côté API, puis effacement du cookie. */
export async function logoutAction(): Promise<void> {
  const session = await readSession();
  if (session !== null) {
    try {
      await apiRequest(transport(), { method: "POST", path: "/v1/auth/logout", accessToken: session.accessToken, context: await clientContext() });
    } catch {
      // Jeton déjà expiré ou API indisponible : la session expirera d'elle-même ; le cookie est effacé.
    }
  }
  const store = await cookies();
  clearCookie(store, SESSION_COOKIE);
  clearCookie(store, PENDING_COOKIE);
  redirect("/");
}
