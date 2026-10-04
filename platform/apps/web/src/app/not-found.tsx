import Link from "next/link";
import type { ReactNode } from "react";

export default function NotFound(): ReactNode {
  return (
    <>
      <h1>Page introuvable</h1>
      <p>
        <Link href="/">Retour à l&apos;accueil</Link>
      </p>
    </>
  );
}
