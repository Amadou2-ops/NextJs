import type { ReactNode } from "react";

/** Pages accessibles sans session : aucun appel authentifié à l'API ici. */
export default function PublicLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <main id="contenu" className="public">
      {children}
    </main>
  );
}
