"use client";

import { startRegistration } from "@simplewebauthn/browser";
import Link from "next/link";
import { useState, useSyncExternalStore, useTransition } from "react";
import type { ReactNode } from "react";

import { completeEnrollmentAction, enrollmentOptionsAction } from "./actions";

const MIN_PASSWORD = 14;

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** Jeton lu dans le fragment (#invitation=…), jamais envoyé au serveur avec la page. */
function invitationFromHash(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("invitation") ?? "";
}

export function EnrollmentForm(): ReactNode {
  const token = useSyncExternalStore(subscribe, invitationFromHash, () => "");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  const submit = (form: FormData): void => {
    const password = form.get("password");
    const confirmation = form.get("passwordConfirmation");
    const nicknameValue = form.get("nickname");
    setError(null);
    setFieldErrors({});
    if (typeof password !== "string" || Array.from(password).length < MIN_PASSWORD) {
      setFieldErrors({ password: `${MIN_PASSWORD.toString()} caractères au moins.` });
      return;
    }
    if (password !== confirmation) {
      setFieldErrors({ passwordConfirmation: "Les deux saisies diffèrent." });
      return;
    }
    const nickname = typeof nicknameValue === "string" && nicknameValue.trim().length > 0 ? nicknameValue.trim() : undefined;
    startTransition(async () => {
      const options = await enrollmentOptionsAction(token);
      if (!options.ok) {
        setError(options.error);
        return;
      }
      let response;
      try {
        response = await startRegistration({ optionsJSON: options.options });
      } catch {
        setError("La clé de sécurité n'a pas été enregistrée (annulée ou non prise en charge). Recommencez.");
        return;
      }
      const result = await completeEnrollmentAction({ token, password, nickname, response });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fields ?? {});
        return;
      }
      // Le jeton est consommé : il est retiré de l'adresse et de l'historique.
      window.history.replaceState(null, "", window.location.pathname);
      setDone(true);
    });
  };

  if (done) {
    return (
      <div className="card stack narrow">
        <p className="alert success" role="status">
          Votre compte est activé. Votre clé de sécurité sera exigée à chaque connexion.
        </p>
        <Link className="button" href="/connexion">
          Se connecter
        </Link>
      </div>
    );
  }

  if (token === "") {
    return (
      <p className="alert error" role="alert">
        Lien d&apos;invitation absent ou incomplet. Utilisez le lien exact transmis par votre administrateur.
      </p>
    );
  }

  return (
    <form action={submit} className="card stack narrow" noValidate>
      {error !== null && (
        <p className="alert error" role="alert">
          {error}
        </p>
      )}
      <label>
        Mot de passe ({MIN_PASSWORD} caractères au moins)
        <input name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} maxLength={128} required aria-invalid={fieldErrors["password"] !== undefined} />
        {fieldErrors["password"] !== undefined && <span className="field-error">{fieldErrors["password"]}</span>}
      </label>
      <label>
        Confirmation du mot de passe
        <input name="passwordConfirmation" type="password" autoComplete="new-password" required aria-invalid={fieldErrors["passwordConfirmation"] !== undefined} />
        {fieldErrors["passwordConfirmation"] !== undefined && <span className="field-error">{fieldErrors["passwordConfirmation"]}</span>}
      </label>
      <label>
        Nom de la clé de sécurité (facultatif)
        <input name="nickname" maxLength={60} autoComplete="off" placeholder="Clé principale" />
      </label>
      <p className="muted small">Seules les clés de sécurité matérielles sont acceptées (les passkeys synchronisées sont refusées).</p>
      <button type="submit" disabled={pending}>
        {pending ? "Enregistrement…" : "Enregistrer ma clé de sécurité et activer mon compte"}
      </button>
    </form>
  );
}
