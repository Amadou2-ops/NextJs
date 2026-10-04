"use client";

import { startRegistration } from "@simplewebauthn/browser";
import QRCode from "qrcode";
import { useActionState, useEffect, useState, useTransition } from "react";

import { FieldError, FormMessage } from "@/components/FormStatus";
import { formatDateTime } from "@/lib/format";
import type { SessionSummary } from "@/lib/types";
import type { ActionState } from "@/server/actionState";

import {
  closeAccountAction,
  confirmTotpAction,
  disableTotpAction,
  passkeyRegistrationOptionsAction,
  passkeyRegistrationVerifyAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  startTotpAction,
} from "./actions";

function Notice({ message, tone }: { readonly message: string | null; readonly tone: "error" | "success" }): React.ReactNode {
  if (message === null) return null;
  return (
    <p className={`alert ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {message}
    </p>
  );
}

export function SessionsPanel({ sessions }: { readonly sessions: readonly SessionSummary[] }): React.ReactNode {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: "error" | "success" } | null>(null);
  return (
    <section className="card stack">
      <h2>Sessions ouvertes</h2>
      <Notice message={message?.text ?? null} tone={message?.tone ?? "success"} />
      <table>
        <thead>
          <tr>
            <th scope="col">Appareil</th>
            <th scope="col">Dernière activité</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.id}>
              <td>
                {session.audience === "mobile" ? (session.deviceName ?? "Application mobile") : "Navigateur web"}
                {session.current && <span className="badge"> cette session</span>}
              </td>
              <td>{formatDateTime(session.lastUsedAt)}</td>
              <td>
                {!session.current && (
                  <button
                    className="secondary"
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const result = await revokeSessionAction(session.id);
                        setMessage(result.status === "error" ? { text: result.message, tone: "error" } : { text: "Session fermée.", tone: "success" });
                      })
                    }
                  >
                    Fermer
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="danger"
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await revokeOtherSessionsAction();
            setMessage(result.status === "error" ? { text: result.message, tone: "error" } : { text: `${(result.status === "success" ? result.data : 0).toString()} session(s) fermée(s).`, tone: "success" });
          })
        }
      >
        Fermer toutes les autres sessions
      </button>
    </section>
  );
}

export function TotpPanel(): React.ReactNode {
  const [pending, startTransition] = useTransition();
  const [enrollment, setEnrollment] = useState<{ readonly secret: string; readonly otpauthUri: string } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: "error" | "success" } | null>(null);

  useEffect(() => {
    if (enrollment === null) return;
    // QR code généré dans le navigateur : le secret ne transite par aucun service tiers.
    QRCode.toDataURL(enrollment.otpauthUri, { margin: 1, width: 220 })
      .then(setQr)
      .catch(() => {
        setQr(null);
      });
  }, [enrollment]);

  return (
    <section className="card stack">
      <h2>Application d&apos;authentification</h2>
      <p className="muted">Exigée pour confirmer un transfert depuis le site (Google Authenticator, Microsoft Authenticator, 1Password…).</p>
      <Notice message={message?.text ?? null} tone={message?.tone ?? "success"} />
      {enrollment === null ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await startTotpAction();
              if (result.status === "success") setEnrollment(result.data);
              else if (result.status === "error") setMessage({ text: result.message, tone: "error" });
            })
          }
        >
          Activer
        </button>
      ) : (
        <div className="stack">
          {qr !== null && (
            // Image générée localement (data URL) : next/image n'apporte rien ici.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} width={220} height={220} alt="QR code à scanner avec votre application d'authentification" />
          )}
          <p>
            Clé à saisir manuellement : <code>{enrollment.secret}</code>
          </p>
        </div>
      )}
      <label>
        Code à 6 chiffres
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
      </label>
      <div className="row">
        {enrollment !== null && (
          <button
            type="button"
            disabled={pending || code.length !== 6}
            onClick={() =>
              startTransition(async () => {
                const result = await confirmTotpAction(code);
                setMessage(result.status === "error" ? { text: result.message, tone: "error" } : { text: "Application d'authentification activée.", tone: "success" });
                if (result.status === "success") setEnrollment(null);
                setCode("");
              })
            }
          >
            Confirmer l&apos;activation
          </button>
        )}
        <button
          className="secondary"
          type="button"
          disabled={pending || code.length !== 6}
          onClick={() =>
            startTransition(async () => {
              const result = await disableTotpAction(code);
              setMessage(result.status === "error" ? { text: result.message, tone: "error" } : { text: "Application d'authentification désactivée.", tone: "success" });
              setCode("");
            })
          }
        >
          Désactiver
        </button>
      </div>
    </section>
  );
}

export function PasskeyPanel(): React.ReactNode {
  const [pending, startTransition] = useTransition();
  const [nickname, setNickname] = useState("");
  const [message, setMessage] = useState<{ readonly text: string; readonly tone: "error" | "success" } | null>(null);
  return (
    <section className="card stack">
      <h2>Passkeys</h2>
      <p className="muted">Connectez-vous sans mot de passe avec l&apos;empreinte, le visage ou le code de cet appareil.</p>
      <Notice message={message?.text ?? null} tone={message?.tone ?? "success"} />
      <label>
        Nom de l&apos;appareil (facultatif)
        <input value={nickname} maxLength={60} onChange={(event) => setNickname(event.target.value)} />
      </label>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const options = await passkeyRegistrationOptionsAction();
            if (options.status !== "success") {
              setMessage({ text: options.status === "error" ? options.message : "Indisponible.", tone: "error" });
              return;
            }
            try {
              const response = await startRegistration({ optionsJSON: options.data.options });
              const result = await passkeyRegistrationVerifyAction(options.data.challengeId, response, nickname);
              setMessage(result.status === "error" ? { text: result.message, tone: "error" } : { text: "Passkey enregistrée.", tone: "success" });
            } catch {
              setMessage({ text: "L'enregistrement de la passkey a été annulé ou refusé par l'appareil.", tone: "error" });
            }
          })
        }
      >
        Ajouter une passkey
      </button>
    </section>
  );
}

export function ClosurePanel(): React.ReactNode {
  const [state, action, pending] = useActionState<ActionState, FormData>(closeAccountAction, { status: "idle" });
  const fields = state.status === "error" ? state.fields : undefined;
  return (
    <section className="card stack">
      <h2>Clôturer mon compte</h2>
      <p className="muted">
        La clôture est définitive : vos sessions, appareils et passkeys sont révoqués. Vos portefeuilles doivent être vides et aucun transfert ne doit être en cours. Vos données sont conservées pour la durée imposée par la réglementation, puis supprimées.
      </p>
      <form action={action} className="stack" noValidate>
        <FormMessage state={state} />
        <label>
          Mot de passe
          <input name="password" type="password" autoComplete="current-password" required aria-invalid={fields?.["password"] !== undefined} aria-describedby="password-erreur" />
          <FieldError fields={fields} name="password" />
        </label>
        <label style={{ flexDirection: "row", alignItems: "flex-start", fontWeight: 400 }}>
          <input type="checkbox" name="confirmation" value="oui" required />
          <span>Je comprends que la clôture de mon compte est définitive.</span>
        </label>
        <FieldError fields={fields} name="confirmation" />
        <button type="submit" className="danger" disabled={pending}>
          {pending ? "Clôture…" : "Clôturer définitivement mon compte"}
        </button>
      </form>
    </section>
  );
}
