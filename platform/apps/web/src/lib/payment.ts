/** Hôtes de paiement hébergé acceptés (protection contre une redirection ouverte). */
const PAYMENT_HOSTS: ReadonlySet<string> = new Set(["checkout.flutterwave.com", "checkout-v2.dev-flutterwave.com"]);

/** URL de paiement hébergé sûre (https, hôte connu), sinon null. */
export function trustedPaymentUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" && PAYMENT_HOSTS.has(url.hostname) && url.username === "" && url.password === "" ? url.toString() : null;
}
