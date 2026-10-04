import type { ReactNode } from "react";

import { Calculator } from "@/components/Calculator";

export default function HomePage(): ReactNode {
  return (
    <>
      <section className="hero">
        <div>
          <h1>Envoyez de l&apos;argent à vos proches, au taux annoncé.</h1>
          <p className="muted">
            Mobile money, compte bancaire ou retrait en espèces. Frais affichés avant de payer, taux garanti par devis, suivi de chaque étape jusqu&apos;à la
            livraison.
          </p>
          <ul>
            <li>Identité vérifiée et transferts surveillés, conformément à la réglementation.</li>
            <li>Paiement par carte, virement ou solde du portefeuille.</li>
            <li>Remboursement automatique si la livraison échoue.</li>
          </ul>
        </div>
        <Calculator />
      </section>
    </>
  );
}
