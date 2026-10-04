"use client";

import { useState, useTransition } from "react";

import { cancelTransferAction } from "./actions";

export function CancelButton({ transferId }: { readonly transferId: string }): React.ReactNode {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="stack">
      {message !== null && (
        <p className="alert error" role="alert">
          {message}
        </p>
      )}
      <button
        className="danger"
        type="button"
        disabled={pending}
        onClick={() => {
          if (!window.confirm("Annuler ce transfert ? Les fonds déjà payés vous seront remboursés.")) return;
          startTransition(async () => {
            const result = await cancelTransferAction(transferId);
            setMessage(result.status === "error" ? result.message : null);
          });
        }}
      >
        {pending ? "Annulation…" : "Annuler le transfert"}
      </button>
    </div>
  );
}
