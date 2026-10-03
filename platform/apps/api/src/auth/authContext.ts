import type { Audience } from "./accessToken.js";

/** Identité authentifiée attachée à la requête par le middleware authenticate. */
export interface AuthContext {
  readonly kind: "customer" | "admin";
  readonly subjectId: string;
  readonly sessionId: string;
  readonly tokenId: string;
  readonly audience: Audience;
  readonly assuranceLevel: 1 | 2;
  readonly deviceId: string | null;
}
