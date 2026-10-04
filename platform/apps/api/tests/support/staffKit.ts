import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Express } from "express";
import type pg from "pg";
import request from "supertest";
import { expect } from "vitest";

import { ADMIN_ORIGIN } from "./fixtures.js";
import { SoftwareAuthenticator } from "./webauthn.js";

/**
 * Personnel de test : compte invité préparé en base, enrôlement et connexion
 * réels (mot de passe + clé WebAuthn logicielle), requêtes authentifiées.
 */

export const RP_ID = "admin.transfertplus.test";
export const LOOPBACK = ["127.0.0.1/32", "::1/128"];

export interface Staff {
  readonly adminId: string;
  readonly email: string;
  readonly password: string;
  readonly authenticator: SoftwareAuthenticator;
  token: string;
  refreshToken: string;
}

export function invitationToken(): string {
  return `inv_${randomBytes(32).toString("base64url")}`;
}

export function createStaffKit(deps: { readonly app: Express; readonly owner: pg.Pool }) {
  const { app, owner } = deps;
  /** Compte invité préparé en base (comme le ferait l'amorçage ou une invitation approuvée). */
  async function invite(roles: readonly string[], ranges: readonly string[] = LOOPBACK): Promise<{ adminId: string; email: string; token: string }> {
    const email = `agent-${randomUUID()}@transfertplus.example`;
    const token = invitationToken();
    const admin = await owner.query<{ id: string }>(
      "INSERT INTO backoffice.admin_users (email, full_name, status, allowed_ip_ranges) VALUES ($1, 'Agent de test', 'invited', $2::cidr[]) RETURNING id",
      [email, ranges],
    );
    const adminId = admin.rows[0]!.id;
    for (const role of roles) {
      await owner.query("INSERT INTO backoffice.admin_user_roles (admin_user_id, role_code) VALUES ($1, $2)", [adminId, role]);
    }
    await owner.query(
      "INSERT INTO backoffice.invitations (admin_user_id, token_sha256, expires_at) VALUES ($1, $2, now() + interval '24 hours')",
      [adminId, createHash("sha256").update(token).digest()],
    );
    return { adminId, email, token };
  }

  async function enroll(token: string, password: string, authenticator: SoftwareAuthenticator, flags: { readonly backupEligible?: boolean } = {}): Promise<request.Response> {
    const options = await request(app).post("/v1/admin/auth/enrollment/options").send({ invitationToken: token });
    expect(options.status).toBe(200);
    return request(app)
      .post("/v1/admin/auth/enrollment/complete")
      .send({ invitationToken: token, challengeId: options.body.challengeId, password, response: authenticator.register(options.body.options as { challenge: string; user: { id: string } }, flags) });
  }

  async function login(email: string, password: string, authenticator: SoftwareAuthenticator): Promise<request.Response> {
    const first = await request(app).post("/v1/admin/auth/login").send({ email, password });
    if (first.status !== 200) return first;
    return request(app).post("/v1/admin/auth/login/verify").send({ challengeId: first.body.challengeId, response: authenticator.authenticate(first.body.options as { challenge: string }) });
  }

  async function staff(roles: readonly string[]): Promise<Staff> {
    const invited = await invite(roles);
    const authenticator = new SoftwareAuthenticator(RP_ID, ADMIN_ORIGIN);
    const password = `Phrase-de-passe-${randomUUID()}`;
    const enrolled = await enroll(invited.token, password, authenticator);
    expect(enrolled.status).toBe(201);
    const session = await login(invited.email, password, authenticator);
    expect(session.status).toBe(200);
    return { adminId: invited.adminId, email: invited.email, password, authenticator, token: session.body.accessToken as string, refreshToken: session.body.refreshToken as string };
  }

  function as(member: Staff) {
    return {
      get: (path: string) => request(app).get(path).set("Authorization", `Bearer ${member.token}`),
      post: (path: string, body: Record<string, unknown> = {}) => request(app).post(path).set("Authorization", `Bearer ${member.token}`).send(body),
      delete: (path: string, body: Record<string, unknown> = {}) => request(app).delete(path).set("Authorization", `Bearer ${member.token}`).send(body),
    };
  }

  return { invite, enroll, login, staff, as };
}
