"use client";

import type { ReactNode } from "react";

/** Erreur inattendue : aucun détail technique n'est affiché (référence seule). */
export default function ErrorPage({ error, reset }: { readonly error: Error & { readonly digest?: string }; readonly reset: () => void }): ReactNode {
  return (
    <>
      <h1>Un incident est survenu</h1>
      <p>Réessayez dans quelques instants. Si le problème persiste, contactez l’équipe technique{error.digest === undefined ? "" : ` en indiquant la référence ${error.digest}`}.</p>
      <button type="button" onClick={reset}>
        Réessayer
      </button>
    </>
  );
}
