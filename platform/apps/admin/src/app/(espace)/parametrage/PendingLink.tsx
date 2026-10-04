import Link from "next/link";
import type { ReactNode } from "react";

/** Demande de modification en cours sur l'élément (lien vers l'approbation). */
export function PendingLink({ id }: { readonly id: string | null }): ReactNode {
  if (id === null) return null;
  return (
    <Link className="badge pending" href={`/approbations/${id}`}>
      Demande en cours
    </Link>
  );
}
