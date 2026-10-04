import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";

import { label, PERMISSION_LABELS } from "@/lib/format";
import type { Permission } from "@/lib/types";

/** Éléments d'affichage partagés du back-office (composants serveur). */

export function Badge({ value, labels, tone }: { readonly value: string; readonly labels?: Readonly<Record<string, string>>; readonly tone?: string }): ReactNode {
  return <span className={`badge ${tone ?? value}`}>{labels === undefined ? value : label(labels, value)}</span>;
}

export function Details({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }): ReactNode {
  return (
    <dl className="details">
      {items.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Données structurées brutes (règles AML, métadonnées), échappées par React. */
export function Json({ value }: { readonly value: unknown }): ReactNode {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function NoAccess({ permission }: { readonly permission: Permission }): ReactNode {
  return (
    <section>
      <h1>Accès refusé</h1>
      <p>
        Cette page exige l&apos;habilitation « {PERMISSION_LABELS[permission]} » (<code>{permission}</code>).
      </p>
    </section>
  );
}

export function Empty({ children }: { readonly children: ReactNode }): ReactNode {
  return <p className="muted empty">{children}</p>;
}

export function NextPage({ href }: { readonly href: Route | null }): ReactNode {
  if (href === null) return null;
  return (
    <p>
      <Link className="button secondary" href={href}>
        Page suivante
      </Link>
    </p>
  );
}

export function Mono({ children }: { readonly children: ReactNode }): ReactNode {
  return <code className="mono">{children}</code>;
}
