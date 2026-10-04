import Link from "next/link";
import type { ReactNode } from "react";

import { formatDateTime, formatMoney, TRANSFER_STATUS_LABELS } from "@/lib/format";
import type { Transfer } from "@/lib/types";

export function TransferList({ transfers }: { readonly transfers: readonly Transfer[] }): ReactNode {
  if (transfers.length === 0) return <p className="muted">Aucun transfert pour le moment.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Bénéficiaire</th>
          <th scope="col">Envoyé</th>
          <th scope="col">Reçu</th>
          <th scope="col">Statut</th>
        </tr>
      </thead>
      <tbody>
        {transfers.map((transfer) => (
          <tr key={transfer.id}>
            <td>
              <Link href={`/transferts/${transfer.id}`}>{formatDateTime(transfer.createdAt)}</Link>
            </td>
            <td>{transfer.recipient.displayHint}</td>
            <td className="amount">{formatMoney(transfer.totalToPay)}</td>
            <td className="amount">{formatMoney(transfer.receiveAmount)}</td>
            <td>
              <span className={`badge ${transfer.status}`}>{TRANSFER_STATUS_LABELS[transfer.status]}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
