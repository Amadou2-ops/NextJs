"use server";

import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { z } from "@/lib/zod";
import type { ActionState } from "@/server/actionState";
import { failure, fromError, keepValues, parseForm } from "@/server/actionState";
import { clearCookie, openSession, publicApi } from "@/server/context";
import { webConfig } from "@/server/env";
import { sessionFromAuthenticated } from "@/server/refresh";
import { PENDING_COOKIE, safeNextPath, sealPending, unsealPending } from "@/server/session";

/**
 * Connexion du client web. Le second facteur (SMS ou application TOTP) est
 * exigé par l'API ; l'étape en cours est conservée dans un cookie chiffré de
 * 10 minutes, jamais dans l'URL.
 */

interface Authenticated {
  readonly status: "authenticated";
  readonly userId: string;
  readonly sessionId: string;
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
}

interface SecondFactorRequired {
  readonly status: "second_factor_required";
  readonly loginChallengeId: string;
  readonly method: "sms_otp" | "totp";
}

const loginSchema = z.strictObject({
  phone: z.string().trim().min(6, "Numéro de téléphone requis").max(32),
  password: z.string().min(1, "Mot de passe requis").max(128),
  suite: z.string().max(200).optional(),
});

export async function loginAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseForm(loginSchema, form);
  if (!parsed.ok) return parsed.state;
  const next = safeNextPath(parsed.data.suite);
  let result: Authenticated | SecondFactorRequired;
  try {
    result = await publicApi<Authenticated | SecondFactorRequired>({
      method: "POST",
      path: "/v1/auth/login",
      body: { phone: parsed.data.phone, password: parsed.data.password, client: { type: "web" } },
    });
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
  if (result.status === "authenticated") {
    await openSession(sessionFromAuthenticated(result));
    redirect((next ?? "/tableau-de-bord"));
  }
  const pending = await sealPending(webConfig().sessionKeys, { kind: "login", loginChallengeId: result.loginChallengeId, method: result.method, next });
  (await cookies()).set(pending.name, pending.value, pending.options);
  redirect("/connexion/verification");
}

const codeSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/, "Code à 6 chiffres") });

export async function verifyLoginAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseForm(codeSchema, form);
  if (!parsed.ok) return parsed.state;
  const store = await cookies();
  const pending = await unsealPending(webConfig().sessionKeys, store.get(PENDING_COOKIE)?.value);
  if (pending?.kind !== "login") return failure("Cette étape a expiré. Reconnectez-vous.");
  let result: Authenticated;
  try {
    result = await publicApi<Authenticated>({ method: "POST", path: "/v1/auth/login/verify", body: { loginChallengeId: pending.loginChallengeId, code: parsed.data.code } });
  } catch (error: unknown) {
    return fromError(error);
  }
  clearCookie(store, PENDING_COOKIE);
  await openSession(sessionFromAuthenticated(result));
  redirect((pending.next ?? "/tableau-de-bord"));
}

/** Passkey (WebAuthn) : options d'authentification, puis vérification. */
export async function passkeyOptionsAction(): Promise<{ readonly challengeId: string; readonly options: PublicKeyCredentialRequestOptionsJSON } | { readonly error: string }> {
  try {
    return await publicApi<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>({ method: "POST", path: "/v1/auth/passkeys/authentication/options" });
  } catch (error: unknown) {
    const state = fromError(error);
    return { error: state.status === "error" ? state.message : "Connexion par passkey indisponible." };
  }
}

export async function passkeyVerifyAction(challengeId: string, response: AuthenticationResponseJSON, suite: string | null): Promise<{ readonly error: string }> {
  if (!/^[0-9a-f-]{36}$/.test(challengeId)) return { error: "Défi invalide." };
  let result: Authenticated;
  try {
    result = await publicApi<Authenticated>({ method: "POST", path: "/v1/auth/passkeys/authentication/verify", body: { challengeId, response } });
  } catch (error: unknown) {
    const state = fromError(error);
    return { error: state.status === "error" ? state.message : "Passkey refusée." };
  }
  await openSession(sessionFromAuthenticated(result));
  redirect((safeNextPath(suite) ?? "/tableau-de-bord"));
}
