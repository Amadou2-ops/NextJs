import 'models.dart';

/// Corridors, pays d'envoi et libellés, identiques au site client.

class Corridor {
  const Corridor(this.country, this.name, this.currency, this.payoutMethods);

  final String country;
  final String name;
  final String currency;
  final List<PayoutMethod> payoutMethods;
}

const List<Corridor> corridors = [
  Corridor('SN', 'Sénégal', 'XOF', [PayoutMethod.mobileMoney, PayoutMethod.bankAccount, PayoutMethod.cashPickup]),
  Corridor('CI', "Côte d'Ivoire", 'XOF', [PayoutMethod.mobileMoney, PayoutMethod.bankAccount, PayoutMethod.cashPickup]),
  Corridor('ML', 'Mali', 'XOF', [PayoutMethod.mobileMoney, PayoutMethod.cashPickup]),
  Corridor('BF', 'Burkina Faso', 'XOF', [PayoutMethod.mobileMoney, PayoutMethod.cashPickup]),
  Corridor('NE', 'Niger', 'XOF', [PayoutMethod.mobileMoney, PayoutMethod.cashPickup]),
  Corridor('MR', 'Mauritanie', 'MRU', [PayoutMethod.mobileMoney, PayoutMethod.bankAccount]),
  Corridor('CM', 'Cameroun', 'XAF', [PayoutMethod.mobileMoney, PayoutMethod.bankAccount]),
  Corridor('MA', 'Maroc', 'MAD', [PayoutMethod.bankAccount, PayoutMethod.cashPickup]),
  Corridor('NG', 'Nigeria', 'NGN', [PayoutMethod.bankAccount, PayoutMethod.mobileMoney]),
  Corridor('GH', 'Ghana', 'GHS', [PayoutMethod.mobileMoney, PayoutMethod.bankAccount]),
  Corridor('KE', 'Kenya', 'KES', [PayoutMethod.mobileMoney, PayoutMethod.bankAccount]),
];

class SendingCountry {
  const SendingCountry(this.country, this.name, this.currency);

  final String country;
  final String name;
  final String currency;
}

const List<SendingCountry> sendingCountries = [
  SendingCountry('FR', 'France', 'EUR'),
  SendingCountry('BE', 'Belgique', 'EUR'),
  SendingCountry('ES', 'Espagne', 'EUR'),
  SendingCountry('IT', 'Italie', 'EUR'),
  SendingCountry('DE', 'Allemagne', 'EUR'),
  SendingCountry('GB', 'Royaume-Uni', 'GBP'),
  SendingCountry('US', 'États-Unis', 'USD'),
  SendingCountry('CA', 'Canada', 'CAD'),
];

/// Devises des pays d'envoi, proposées à l'ouverture d'un portefeuille.
final List<String> walletCurrencies = {for (final country in sendingCountries) country.currency}.toList(growable: false);

const Map<String, String> mobileOperators = {
  'orange_money': 'Orange Money',
  'wave': 'Wave',
  'mtn_momo': 'MTN MoMo',
  'moov_money': 'Moov Money',
  'free_money': 'Free Money',
  'mpesa': 'M-Pesa',
  'airtel_money': 'Airtel Money',
  'vodafone_cash': 'Vodafone Cash',
  'mynita': 'MyNita',
  'zamani_cash': 'Zamani Cash',
  'bankily': 'Bankily',
  'masrvi': 'Masrvi',
  'sedad': 'Sedad',
  'click': 'Click',
};

/// Opérateurs proposés selon le pays du bénéficiaire (même règle que l'API).
const Map<String, List<String>> _nationalOperators = {
  'NE': ['airtel_money', 'moov_money', 'zamani_cash', 'mynita'],
  'MR': ['bankily', 'masrvi', 'sedad', 'click'],
};
const Set<String> _nationalOnly = {'zamani_cash', 'mynita', 'bankily', 'masrvi', 'sedad', 'click'};

Map<String, String> mobileOperatorsFor(String country) {
  final national = _nationalOperators[country];
  return {
    for (final entry in mobileOperators.entries)
      if (national == null ? !_nationalOnly.contains(entry.key) : national.contains(entry.key)) entry.key: entry.value,
  };
}

const Map<String, String> purposes = {
  'family_support': 'Soutien familial',
  'education': 'Études',
  'medical_treatment': 'Frais médicaux',
  'gift': 'Cadeau',
  'household_expenses': 'Dépenses du foyer',
  'savings': 'Épargne',
  'travel': 'Voyage',
  'other': 'Autre',
};

const Map<String, String> relationships = {
  'family': 'Famille',
  'friend': 'Ami',
  'self': 'Moi-même',
  'business': 'Professionnel',
  'other': 'Autre',
};

String payoutLabel(PayoutMethod method) => switch (method) {
      PayoutMethod.mobileMoney => 'Mobile money',
      PayoutMethod.bankAccount => 'Compte bancaire',
      PayoutMethod.cashPickup => 'Retrait en espèces',
      PayoutMethod.card => 'Carte bancaire',
      PayoutMethod.wallet => 'Portefeuille',
    };

String fundingLabel(FundingMethod method) => switch (method) {
      FundingMethod.walletBalance => 'Solde du portefeuille',
      FundingMethod.card => 'Carte bancaire',
      FundingMethod.bankTransfer => 'Virement bancaire',
      FundingMethod.mobileMoney => 'Mobile money',
      FundingMethod.applePay => 'Apple Pay',
      FundingMethod.googlePay => 'Google Pay',
    };

String transferStatusLabel(TransferStatus status) => switch (status) {
      TransferStatus.created => 'Créé',
      TransferStatus.awaitingFunding => 'En attente de paiement',
      TransferStatus.fundingProcessing => 'Paiement en cours de confirmation',
      TransferStatus.funded => 'Payé',
      TransferStatus.complianceReview => 'Vérification en cours',
      TransferStatus.payoutPending => 'Envoi en préparation',
      TransferStatus.payoutProcessing => 'Envoi en cours',
      TransferStatus.completed => 'Livré',
      TransferStatus.payoutFailed => 'Envoi en échec, nouvelle tentative',
      TransferStatus.cancelled => 'Annulé',
      TransferStatus.refundPending => 'Remboursement en cours',
      TransferStatus.refunded => 'Remboursé',
    };

String kycTierLabel(KycTier tier) => switch (tier) {
      KycTier.tier0 => 'Non vérifié',
      KycTier.tier1 => 'Identité vérifiée',
      KycTier.tier2 => 'Vérification renforcée',
      KycTier.tier3 => 'Vérification complète',
    };

String kycStatusLabel(KycStatus status) => switch (status) {
      KycStatus.created || KycStatus.pendingSubmission => 'À compléter',
      KycStatus.submitted || KycStatus.inReview => 'En cours d\'examen',
      KycStatus.approved => 'Approuvée',
      KycStatus.rejected => 'Refusée',
      KycStatus.resubmissionRequired => 'Nouvelle pièce demandée',
      KycStatus.expired => 'Expirée',
    };
