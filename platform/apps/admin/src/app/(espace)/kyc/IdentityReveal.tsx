"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";

import type { ActionState } from "@/server/actionState";

import type { RevealedIdentity } from "./actions";

export function IdentityReveal({ action }: { readonly action: (state: ActionState<RevealedIdentity>) => Promise<ActionState<RevealedIdentity>> }): ReactNode {
  const [state, dispatch, pending] = useActionState<ActionState<RevealedIdentity>>(action, { status: "idle" });
  if (state.status === "success") {
    return (
      <p>
        <strong>{state.data.fullName ?? "—"}</strong>, né(e) le {state.data.dateOfBirth ?? "—"} <span className="muted small">(consultation tracée)</span>
      </p>
    );
  }
  return (
    <form action={dispatch}>
      {state.status === "error" && (
        <p className="alert error" role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" className="secondary small-button" disabled={pending}>
        {pending ? "Déchiffrement…" : "Afficher l'identité lue sur la pièce"}
      </button>
    </form>
  );
}
