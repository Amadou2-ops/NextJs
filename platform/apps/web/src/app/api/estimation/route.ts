import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { z } from "@/lib/zod";
import type { Quote } from "@/lib/types";
import { ApiError } from "@/server/api";
import { publicApi } from "@/server/context";

/**
 * Simulation publique (calculateur de la page d'accueil). Paramètres
 * validés avant transmission ; la limitation de débit par IP est appliquée
 * par l'API (adresse du navigateur transmise).
 */

const querySchema = z.strictObject({
  sourceCountry: z.string().regex(/^[A-Z]{2}$/),
  destinationCountry: z.string().regex(/^[A-Z]{2}$/),
  sourceCurrency: z.string().regex(/^[A-Z]{3}$/),
  destinationCurrency: z.string().regex(/^[A-Z]{3}$/),
  payoutMethod: z.enum(["mobile_money", "bank_account", "cash_pickup"]),
  amount: z.string().regex(/^[1-9][0-9]{0,14}$/),
  amountType: z.enum(["send", "receive"]).default("send"),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ code: "VALIDATION_FAILED", message: "Paramètres de simulation invalides." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const quote = await publicApi<Quote>({ path: "/v1/fx/estimate", query: { ...parsed.data, fundingMethod: "card" } });
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      return NextResponse.json({ code: error.code, message: error.status === 429 ? "Trop de simulations : patientez un instant." : "Simulation indisponible pour ce corridor." }, { status: error.status >= 500 ? 503 : error.status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
