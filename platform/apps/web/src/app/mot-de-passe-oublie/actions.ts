"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SENDING_COUNTRIES } from "@/lib/format";
import { z } from "@/lib/zod";
import type { ActionState } from "@/server/actionState";
import { failure, fromError, keepValues, parseForm } from "@/server/actionState";
import { clearCookie, publicApi } from "@/server/context";
import { ApiError } from "@/server/api";
import { webConfig } from "@/server/env";
import { PENDING_COOKIE, sealPending, unsealPending } from "@/server/session";

/**
 * Mot de passe oublié : numéro de téléphone (code SMS envoyé par l'API si un
 * compte actif y correspond, réponse identique sinon), puis code, code de
 * l'application d'authentification si elle est activée, et nouveau mot de
 * passe. Toutes les sessions du client sont fermées par l'API.
 */

const countries = SENDING_COUNTRIES.map((item) => item.country) as [string, ...string[]];

const startSchema = z.strictObject({
  phone: z.string().trim().min(6, "Numéro de téléphone requis").max(32),
  country: z.enum(countries, "Pays non pris en charge"),
});

export async function startPasswordResetAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseForm(startSchema, form);
  if (!parsed.ok) return parsed.state;
  let challenge: { challengeId: string };
  try {
    challenge = await publicApi<{ challengeId: string }>({
      method: "POST",
      path: "/v1/auth/password-reset/start",
      body: { phone: parsed.data.phone, countryHint: parsed.data.country, locale: "fr" },
    });
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
  const pending = await sealPending(webConfig().sessionKeys, {
    kind: "password_reset",
    challengeId: challenge.challengeId,
    phone: parsed.data.phone,
    countryHint: parsed.data.country,
  });
  (await cookies()).set(pending.name, pending.value, pending.options);
  redirect("/mot-de-passe-oublie/nouveau");
}

const completeSchema = z
  .strictObject({
    code: z.string().regex(/^\d{6}$/, "Code à 6 chiffres"),
    totpCode: z.union([z.literal(""), z.string().regex(/^\d{6}$/, "Code à 6 chiffres")]),
    password: z.string().min(10, "10 caractères au moins").max(128),
    confirmation: z.string(),
  })
  .refine((value) => value.password === value.confirmation, { path: ["confirmation"], message: "Les mots de passe ne correspondent pas" });

export async function completePasswordResetAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseForm(completeSchema, form);
  if (!parsed.ok) return parsed.state;
  const store = await cookies();
  const pending = await unsealPending(webConfig().sessionKeys, store.get(PENDING_COOKIE)?.value);
  if (pending?.kind !== "password_reset") return failure("Cette étape a expiré. Recommencez la réinitialisation.");
  try {
    await publicApi({
      method: "POST",
      path: "/v1/auth/password-reset/complete",
      body: {
        challengeId: pending.challengeId,
        code: parsed.data.code,
        phone: pending.phone,
        countryHint: pending.countryHint,
        password: parsed.data.password,
        ...(parsed.data.totpCode === "" ? {} : { totpCode: parsed.data.totpCode }),
      },
    });
  } catch (error: unknown) {
    // Code consommé ou expiré : un nouveau code est nécessaire.
    if (error instanceof ApiError && (error.code === "TOTP_REQUIRED" || error.code === "VERIFICATION_EXPIRED")) clearCookie(store, PENDING_COOKIE);
    return fromError(error);
  }
  clearCookie(store, PENDING_COOKIE);
  redirect("/connexion?reinitialise=1");
}
