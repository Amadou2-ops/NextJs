/// Hôtes de paiement hébergé acceptés (protection contre une redirection
/// ouverte), identiques au site client.
const Set<String> _paymentHosts = {'checkout.flutterwave.com', 'checkout-v2.dev-flutterwave.com'};

/// URL de paiement hébergé sûre (https, hôte connu, sans identifiants), sinon null.
Uri? trustedPaymentUrl(Uri url) {
  if (url.scheme != 'https' || !_paymentHosts.contains(url.host) || url.userInfo.isNotEmpty) return null;
  return url;
}
