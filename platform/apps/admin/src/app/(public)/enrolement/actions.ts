"use server";

import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { cookies } from "next/headers";

import { z } from "@/lib/zod";
import { fromError } from "@/server/actionState";
import { clearCookie, publicApi } from "@/server/context";
import { adminConfig } from "@/server/env";
import { PENDING_COOKIE, sealPending, unsealPending } from "@/server/session";
import { webauthnResponseSchema } from "@/server/webauthn";

/**
 * Enrôlement d'un membre invité : le jeton d'invitation (fragment d'URL,
 * jamais transmis dans une requête de page ni journalisé) est présenté par
 * le navigateur, l'API génère le défi d'enregistrement de la clé de sécurité,
 * puis vérifie la clé (matérielle, non synchronisée) et le mot de passe.
 */

const invitationToken = z.string().regex(/^inv_[A-Za-z0-9_-]{43}$/);

interface Failure {
  readonly ok: false;
  readonly error: string;
  readonly fields?: Readonly<Record<string, string>>;
}

function failureOf(error: unknown): Failure {
  const state = fromError(error);
  return state.status === "error" ? { ok: false, error: state.message, fields: state.fields } : { ok: false, error: "Enrôlement impossible." };
}

export async function enrollmentOptionsAction(token: string): Promise<{ readonly ok: true; readonly options: PublicKeyCredentialCreationOptionsJSON } | Failure> {
  if (!invitationToken.safeParse(token).success) return { ok: false, error: "Lien d'invitation invalide ou incomplet." };
  let result: { challengeId: string; options: PublicKeyCredentialCreationOptionsJSON };
  try {
    result = await publicApi({ method: "POST", path: "/v1/admin/auth/enrollment/options", body: { invitationToken: token } });
  } catch (error: unknown) {
    return failureOf(error);
  }
  const pending = await sealPending(adminConfig().sessionKeys, { kind: "enrollment", challengeId: result.challengeId });
  (await cookies()).set(pending.name, pending.value, pending.options);
  return { ok: true, options: result.options };
}

const completionSchema = z.strictObject({
  token: invitationToken,
  password: z.string().min(14, "14 caractères au moins").max(128),
  nickname: z.string().trim().min(1).max(60).optional(),
  response: webauthnResponseSchema,
});

export async function completeEnrollmentAction(input: {
  readonly token: string;
  readonly password: string;
  readonly nickname: string | undefined;
  readonly response: RegistrationResponseJSON;
}): Promise<{ readonly ok: true } | Failure> {
  const parsed = completionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Informations d'enrôlement invalides." };
  const store = await cookies();
  const pending = await unsealPending(adminConfig().sessionKeys, store.get(PENDING_COOKIE)?.value);
  if (pending?.kind !== "enrollment") return { ok: false, error: "Cette étape a expiré. Recommencez l'enrôlement." };
  try {
    await publicApi({
      method: "POST",
      path: "/v1/admin/auth/enrollment/complete",
      body: {
        invitationToken: parsed.data.token,
        challengeId: pending.challengeId,
        password: parsed.data.password,
        response: parsed.data.response,
        ...(parsed.data.nickname === undefined ? {} : { nickname: parsed.data.nickname }),
      },
    });
  } catch (error: unknown) {
    clearCookie(store, PENDING_COOKIE);
    return failureOf(error);
  }
  clearCookie(store, PENDING_COOKIE);
  return { ok: true };
}
