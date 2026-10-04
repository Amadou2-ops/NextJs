"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SENDING_COUNTRIES } from "@/lib/format";
import { z } from "@/lib/zod";
import type { ActionState } from "@/server/actionState";
import { failure, fromError, keepValues, parseForm } from "@/server/actionState";
import { clearCookie, openSession, publicApi } from "@/server/context";
import { webConfig } from "@/server/env";
import { sessionFromAuthenticated } from "@/server/refresh";
import { PENDING_COOKIE, sealPending, unsealPending } from "@/server/session";

/**
 * Inscription en deux temps : numéro de téléphone (code SMS envoyé par
 * l'API), puis code + mot de passe. Le compte naît au niveau KYC 0 : la
 * vérification d'identité est proposée juste après.
 */

const countries = SENDING_COUNTRIES.map((item) => item.country) as [string, ...string[]];

const startSchema = z.strictObject({
  phone: z.string().trim().min(6, "Numéro de téléphone requis").max(32),
  countryOfResidence: z.enum(countries, "Pays de résidence non pris en charge"),
  consent: z.literal("oui", "Vous devez accepter les conditions"),
});

export async function startRegistrationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseForm(startSchema, form);
  if (!parsed.ok) return parsed.state;
  let challenge: { challengeId: string };
  try {
    challenge = await publicApi<{ challengeId: string }>({
      method: "POST",
      path: "/v1/auth/registration/start",
      body: { phone: parsed.data.phone, countryHint: parsed.data.countryOfResidence, locale: "fr" },
    });
  } catch (error: unknown) {
    return keepValues(fromError(error), form);
  }
  const pending = await sealPending(webConfig().sessionKeys, {
    kind: "registration",
    challengeId: challenge.challengeId,
    phone: parsed.data.phone,
    countryOfResidence: parsed.data.countryOfResidence,
  });
  (await cookies()).set(pending.name, pending.value, pending.options);
  redirect("/inscription/confirmation");
}

const completeSchema = z
  .strictObject({
    code: z.string().regex(/^\d{6}$/, "Code à 6 chiffres"),
    password: z.string().min(10, "10 caractères au moins").max(128),
    confirmation: z.string(),
  })
  .refine((value) => value.password === value.confirmation, { path: ["confirmation"], message: "Les mots de passe ne correspondent pas" });

export async function completeRegistrationAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const parsed = parseForm(completeSchema, form);
  if (!parsed.ok) return parsed.state;
  const store = await cookies();
  const pending = await unsealPending(webConfig().sessionKeys, store.get(PENDING_COOKIE)?.value);
  if (pending?.kind !== "registration") return failure("Cette étape a expiré. Recommencez l'inscription.");
  let result: Parameters<typeof sessionFromAuthenticated>[0];
  try {
    result = await publicApi({
      method: "POST",
      path: "/v1/auth/registration/complete",
      body: {
        challengeId: pending.challengeId,
        code: parsed.data.code,
        phone: pending.phone,
        password: parsed.data.password,
        countryOfResidence: pending.countryOfResidence,
        preferredLocale: "fr",
        client: { type: "web" },
      },
    });
  } catch (error: unknown) {
    return fromError(error);
  }
  clearCookie(store, PENDING_COOKIE);
  await openSession(sessionFromAuthenticated(result));
  redirect("/verification");
}
