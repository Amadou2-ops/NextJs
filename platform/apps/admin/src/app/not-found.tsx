import Link from "next/link";
import type { ReactNode } from "react";

export default function NotFound(): ReactNode {
  return (
    <main className="public">
      <h1>Élément introuvable</h1>
      <p>
        <Link href="/">Retour à l&apos;accueil du back-office</Link>
      </p>
    </main>
  );
}
