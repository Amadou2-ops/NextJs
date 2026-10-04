"use server";

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { z } from "@/lib/zod";
import type { ActionState } from "@/server/actionState";
import { fromError, keepValues, parseForm } from "@/server/actionState";
import { clearCookie, openSession, publicApi } from "@/server/context";
import { adminConfig } from "@/server/env";
import type { AdminTokens } from "@/server/session";
import { PENDING_COOKIE, safeNextPath, sealPending, sessionFromTokens, unsealPending } from "@/server/session";
import { webauthnResponseSchema } from "@/server/webauthn";

/**
 * Connexion du personnel en deux temps : mot de passe, puis assertion de la
 * clé de sécurité liée au défi, au compte et à l'adresse IP (vérifiée par
 * l'API). L'identifiant du défi reste dans un cookie chiffré de 5 minutes.
 */

export type LoginState = ActionState<{ readonly options: PublicKeyCredentialRequestOptionsJSON }>;

const loginSchema = z.strictObject({
  email: z.email("Adresse e-mail professionnelle requise").max(254),
  password: z.string().min(1, "Mot de passe requis").max(128),
  suite: z.string().max(200).optional(),
});

export async function startLoginAction(_previous: LoginState, form: FormData): Promise<LoginState> {
  const parsed = parseForm(loginSchema, form);
  if (!parsed.ok) return parsed.state;
  let challenge: { challengeId: string; options: PublicKeyCredentialRequestOptionsJSON };
  try {
    challenge = await publicApi({ method: "POST", path: "/v1/admin/auth/login", body: { email: parsed.data.email, password: parsed.data.password } });
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
  const pending = await sealPending(adminConfig().sessionKeys, { kind: "login", challengeId: challenge.challengeId, next: safeNextPath(parsed.data.suite) });
  (await cookies()).set(pending.name, pending.value, pending.options);
  return { status: "success", data: { options: challenge.options } };
}

export async function completeLoginAction(response: AuthenticationResponseJSON): Promise<{ readonly error: string }> {
  const checked = webauthnResponseSchema.safeParse(response);
  if (!checked.success) return { error: "Réponse de la clé de sécurité invalide." };
  const store = await cookies();
  const pending = await unsealPending(adminConfig().sessionKeys, store.get(PENDING_COOKIE)?.value);
  if (pending?.kind !== "login") return { error: "Cette étape a expiré. Recommencez la connexion." };
  let tokens: AdminTokens;
  try {
    tokens = await publicApi<AdminTokens>({ method: "POST", path: "/v1/admin/auth/login/verify", body: { challengeId: pending.challengeId, response: checked.data } });
  } catch (error: unknown) {
    clearCookie(store, PENDING_COOKIE);
    const state = fromError(error);
    return { error: state.status === "error" ? state.message : "Clé de sécurité refusée." };
  }
  clearCookie(store, PENDING_COOKIE);
  await openSession(sessionFromTokens(tokens));
  redirect(pending.next ?? "/");
}

export async function abandonLoginAction(): Promise<void> {
  clearCookie(await cookies(), PENDING_COOKIE);
}

