"use server";

import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { revalidatePath } from "next/cache";

import { z } from "@/lib/zod";
import type { ActionState } from "@/server/actionState";
import { failure, fromError } from "@/server/actionState";
import { actionApi } from "@/server/context";

/** Sécurité du compte : sessions, application d'authentification (TOTP), passkeys. */

export async function revokeSessionAction(sessionId: string): Promise<ActionState> {
  if (!z.uuid().safeParse(sessionId).success) return failure("Session introuvable.");
  try {
    await actionApi({ method: "DELETE", path: `/v1/auth/sessions/${sessionId}` });
  } catch (error: unknown) {
    return fromError(error);
  }
  revalidatePath("/securite");
  return { status: "success", data: undefined };
}

export async function revokeOtherSessionsAction(): Promise<ActionState<number>> {
  try {
    const result = await actionApi<{ revoked: number }>({ method: "POST", path: "/v1/auth/sessions/revoke-others" });
    revalidatePath("/securite");
    return { status: "success", data: result.revoked };
  } catch (error: unknown) {
    return fromError(error);
  }
}

export async function startTotpAction(): Promise<ActionState<{ readonly secret: string; readonly otpauthUri: string }>> {
  try {
    return { status: "success", data: await actionApi<{ secret: string; otpauthUri: string }>({ method: "POST", path: "/v1/auth/mfa/totp/setup" }) };
  } catch (error: unknown) {
    return fromError(error);
  }
}

const code = z.string().regex(/^\d{6}$/, "Code à 6 chiffres");

export async function confirmTotpAction(value: string): Promise<ActionState> {
  if (!code.safeParse(value).success) return failure("Saisissez le code à 6 chiffres.");
  try {
    await actionApi({ method: "POST", path: "/v1/auth/mfa/totp/confirm", body: { code: value } });
    return { status: "success", data: undefined };
  } catch (error: unknown) {
    return fromError(error);
  }
}

export async function disableTotpAction(value: string): Promise<ActionState> {
  if (!code.safeParse(value).success) return failure("Saisissez le code à 6 chiffres.");
  try {
    await actionApi({ method: "POST", path: "/v1/auth/mfa/totp/disable", body: { code: value } });
    return { status: "success", data: undefined };
  } catch (error: unknown) {
    return fromError(error);
  }
}

export async function passkeyRegistrationOptionsAction(): Promise<ActionState<{ readonly challengeId: string; readonly options: PublicKeyCredentialCreationOptionsJSON }>> {
  try {
    return { status: "success", data: await actionApi({ method: "POST", path: "/v1/auth/passkeys/registration/options" }) };
  } catch (error: unknown) {
    return fromError(error);
  }
}

export async function passkeyRegistrationVerifyAction(challengeId: string, response: RegistrationResponseJSON, nickname: string): Promise<ActionState> {
  if (!z.uuid().safeParse(challengeId).success) return failure("Défi invalide.");
  const label = nickname.trim().slice(0, 60);
  try {
    await actionApi({ method: "POST", path: "/v1/auth/passkeys/registration/verify", body: { challengeId, response, ...(label.length > 0 ? { nickname: label } : {}) } });
    return { status: "success", data: undefined };
  } catch (error: unknown) {
    return fromError(error);
  }
}
