import '../core/api/json.dart';
import '../core/format/money.dart';

/// Modèles des réponses de l'API (contrat packages/contracts/openapi.yaml).

class AuthenticatedSession {
  const AuthenticatedSession({
    required this.userId,
    required this.sessionId,
    required this.deviceId,
    required this.accessToken,
    required this.accessTokenExpiresAt,
    required this.refreshToken,
    required this.refreshTokenExpiresAt,
  });

  factory AuthenticatedSession.fromJson(Json json) {
    if (json.string('status') != 'authenticated') throw const FormatException('session authentifiée attendue');
    return AuthenticatedSession(
      userId: json.string('userId'),
      sessionId: json.string('sessionId'),
      deviceId: json.optionalString('deviceId'),
      accessToken: json.string('accessToken'),
      accessTokenExpiresAt: json.dateTime('accessTokenExpiresAt'),
      refreshToken: json.string('refreshToken'),
      refreshTokenExpiresAt: json.dateTime('refreshTokenExpiresAt'),
    );
  }

  final String userId;
  final String sessionId;
  final String? deviceId;
  final String accessToken;
  final DateTime accessTokenExpiresAt;
  final String refreshToken;
  final DateTime refreshTokenExpiresAt;
}

enum SecondFactorMethod implements WireEnum {
  smsOtp('sms_otp'),
  totp('totp');

  const SecondFactorMethod(this.wire);

  @override
  final String wire;
}

sealed class LoginOutcome {
  const LoginOutcome();
}

class LoginAuthenticated extends LoginOutcome {
  const LoginAuthenticated(this.session);

  final AuthenticatedSession session;
}

class LoginSecondFactor extends LoginOutcome {
  const LoginSecondFactor({required this.loginChallengeId, required this.method});

  final String loginChallengeId;
  final SecondFactorMethod method;
}

enum PayoutMethod implements WireEnum {
  bankAccount('bank_account'),
  mobileMoney('mobile_money'),
  cashPickup('cash_pickup'),
  card('card'),
  wallet('wallet');

  const PayoutMethod(this.wire);

  @override
  final String wire;
}

enum FundingMethod implements WireEnum {
  walletBalance('wallet_balance'),
  card('card'),
  bankTransfer('bank_transfer'),
  mobileMoney('mobile_money'),
  applePay('apple_pay'),
  googlePay('google_pay');

  const FundingMethod(this.wire);

  @override
  final String wire;
}

enum TransferStatus implements WireEnum {
  created('created'),
  awaitingFunding('awaiting_funding'),
  fundingProcessing('funding_processing'),
  funded('funded'),
  complianceReview('compliance_review'),
  payoutPending('payout_pending'),
  payoutProcessing('payout_processing'),
  completed('completed'),
  payoutFailed('payout_failed'),
  cancelled('cancelled'),
  refundPending('refund_pending'),
  refunded('refunded');

  const TransferStatus(this.wire);

  @override
  final String wire;
}

class Quote {
  const Quote({
    required this.quoteId,
    required this.destinationCountry,
    required this.payoutMethod,
    required this.fundingMethod,
    required this.sendAmount,
    required this.fee,
    required this.totalToPay,
    required this.receiveAmount,
    required this.exchangeRate,
    required this.estimatedDeliveryMinutes,
    required this.expiresAt,
  });

  factory Quote.fromJson(Json json) => Quote(
        quoteId: json.optionalString('quoteId'),
        destinationCountry: json.string('destinationCountry'),
        payoutMethod: json.oneOf('payoutMethod', PayoutMethod.values),
        fundingMethod: json.oneOf('fundingMethod', FundingMethod.values),
        sendAmount: Money.fromJson(json['sendAmount']),
        fee: Money.fromJson(json['fee']),
        totalToPay: Money.fromJson(json['totalToPay']),
        receiveAmount: Money.fromJson(json['receiveAmount']),
        exchangeRate: json.string('exchangeRate'),
        estimatedDeliveryMinutes: json.optionalInteger('estimatedDeliveryMinutes'),
        expiresAt: json.optionalDateTime('expiresAt'),
      );

  final String? quoteId;
  final String destinationCountry;
  final PayoutMethod payoutMethod;
  final FundingMethod fundingMethod;
  final Money sendAmount;
  final Money fee;
  final Money totalToPay;
  final Money receiveAmount;
  final String exchangeRate;
  final int? estimatedDeliveryMinutes;
  final DateTime? expiresAt;
}

class Recipient {
  const Recipient({
    required this.id,
    required this.country,
    required this.currency,
    required this.payoutMethod,
    required this.firstName,
    required this.lastName,
    required this.displayHint,
    required this.mobileOperator,
  });

  factory Recipient.fromJson(Json json) => Recipient(
        id: json.string('id'),
        country: json.string('country'),
        currency: json.string('currency'),
        payoutMethod: json.oneOf('payoutMethod', PayoutMethod.values),
        firstName: json.string('firstName'),
        lastName: json.string('lastName'),
        displayHint: json.string('displayHint'),
        mobileOperator: json.optionalString('mobileOperator'),
      );

  final String id;
  final String country;
  final String currency;
  final PayoutMethod payoutMethod;
  final String firstName;
  final String lastName;
  final String displayHint;
  final String? mobileOperator;

  String get fullName => '$firstName $lastName';
}

class Transfer {
  const Transfer({
    required this.id,
    required this.reference,
    required this.status,
    required this.statusReason,
    required this.recipientHint,
    required this.sendAmount,
    required this.fee,
    required this.totalToPay,
    required this.receiveAmount,
    required this.exchangeRate,
    required this.fundingMethod,
    required this.payoutMethod,
    required this.createdAt,
    required this.history,
  });

  factory Transfer.fromJson(Json json) => Transfer(
        id: json.string('id'),
        reference: json.string('reference'),
        status: json.oneOf('status', TransferStatus.values),
        statusReason: json.optionalString('statusReason'),
        recipientHint: json.object('recipient').string('displayHint'),
        sendAmount: Money.fromJson(json['sendAmount']),
        fee: Money.fromJson(json['fee']),
        totalToPay: Money.fromJson(json['totalToPay']),
        receiveAmount: Money.fromJson(json['receiveAmount']),
        exchangeRate: json.string('exchangeRate'),
        fundingMethod: json.oneOf('fundingMethod', FundingMethod.values),
        payoutMethod: json.oneOf('payoutMethod', PayoutMethod.values),
        createdAt: json.dateTime('createdAt'),
        history: json['history'] == null
            ? const []
            : [for (final item in json.objects('history')) (status: item.oneOf('status', TransferStatus.values), at: item.dateTime('at'))],
      );

  final String id;
  final String reference;
  final TransferStatus status;
  final String? statusReason;
  final String recipientHint;
  final Money sendAmount;
  final Money fee;
  final Money totalToPay;
  final Money receiveAmount;
  final String exchangeRate;
  final FundingMethod fundingMethod;
  final PayoutMethod payoutMethod;
  final DateTime createdAt;
  final List<({TransferStatus status, DateTime at})> history;

  bool get cancellable => status == TransferStatus.created || status == TransferStatus.awaitingFunding;
}

sealed class FundingAction {
  const FundingAction();

  static FundingAction? fromJson(Object? value) {
    if (value == null) return null;
    final json = asObject(value, 'action de paiement');
    return switch (json.string('type')) {
      'stripe_payment_intent' => StripeFunding(clientSecret: json.string('clientSecret'), publishableKey: json.string('publishableKey')),
      'redirect' => RedirectFunding(Uri.parse(json.string('url'))),
      final other => throw FormatException('action de paiement inconnue : $other'),
    };
  }
}

class StripeFunding extends FundingAction {
  const StripeFunding({required this.clientSecret, required this.publishableKey});

  final String clientSecret;
  final String publishableKey;
}

class RedirectFunding extends FundingAction {
  const RedirectFunding(this.url);

  final Uri url;
}

class Wallet {
  const Wallet({required this.currency, required this.available, required this.held});

  factory Wallet.fromJson(Json json) => Wallet(currency: json.string('currency'), available: Money.fromJson(json['available']), held: Money.fromJson(json['held']));

  final String currency;
  final Money available;
  final Money held;
}

class StatementEntry {
  const StatementEntry({required this.entryId, required this.incoming, required this.amount, required this.balanceAfter, required this.description, required this.effectiveAt});

  factory StatementEntry.fromJson(Json json) => StatementEntry(
        entryId: json.string('entryId'),
        incoming: json.string('direction') == 'in',
        amount: Money.fromJson(json['amount']),
        balanceAfter: Money.fromJson(json['balanceAfter']),
        description: json.string('description'),
        effectiveAt: json.dateTime('effectiveAt'),
      );

  final String entryId;
  final bool incoming;
  final Money amount;
  final Money balanceAfter;
  final String description;
  final DateTime effectiveAt;
}

enum KycTier implements WireEnum {
  tier0('tier_0'),
  tier1('tier_1'),
  tier2('tier_2'),
  tier3('tier_3');

  const KycTier(this.wire);

  @override
  final String wire;
}

enum KycStatus implements WireEnum {
  created('created'),
  pendingSubmission('pending_submission'),
  submitted('submitted'),
  inReview('in_review'),
  approved('approved'),
  rejected('rejected'),
  resubmissionRequired('resubmission_required'),
  expired('expired');

  const KycStatus(this.wire);

  @override
  final String wire;
}

class KycVerification {
  const KycVerification({required this.id, required this.tier, required this.provider, required this.status, required this.createdAt});

  factory KycVerification.fromJson(Json json) => KycVerification(
        id: json.string('id'),
        tier: json.oneOf('tier', KycTier.values),
        provider: json.string('provider'),
        status: json.oneOf('status', KycStatus.values),
        createdAt: json.dateTime('createdAt'),
      );

  final String id;
  final KycTier tier;
  final String provider;
  final KycStatus status;
  final DateTime createdAt;
}

class KycOverview {
  const KycOverview({required this.tier, required this.singleTransferMax, required this.monthlyMax, required this.nextTier, required this.attemptsRemaining, required this.activeVerification});

  factory KycOverview.fromJson(Json json) {
    final limits = json.object('limits');
    final next = json.optionalString('nextTier');
    final active = json.optionalObject('activeVerification');
    return KycOverview(
      tier: json.oneOf('tier', KycTier.values),
      singleTransferMax: Money.fromJson(limits['singleTransferMax']),
      monthlyMax: Money.fromJson(limits['monthlyMax']),
      nextTier: next == null ? null : wireValue(next, KycTier.values),
      attemptsRemaining: json.integer('attemptsRemaining'),
      activeVerification: active == null ? null : KycVerification.fromJson(active),
    );
  }

  final KycTier tier;
  final Money singleTransferMax;
  final Money monthlyMax;
  final KycTier? nextTier;
  final int attemptsRemaining;
  final KycVerification? activeVerification;
}

sealed class KycLaunch {
  const KycLaunch();

  static KycLaunch fromJson(Json json) => switch (json.string('provider')) {
        'onfido' => OnfidoLaunch(sdkToken: json.string('sdkToken'), workflowRunId: json.string('workflowRunId')),
        'smile_id' => SmileIdLaunch(
            partnerId: json.string('partnerId'),
            sandbox: json.string('environment') == 'sandbox',
            jobId: json.string('jobId'),
            userId: json.string('userId'),
            jobType: json.integer('jobType'),
            callbackUrl: Uri.parse(json.string('callbackUrl')),
          ),
        final other => throw FormatException('prestataire KYC inconnu : $other'),
      };
}

class OnfidoLaunch extends KycLaunch {
  const OnfidoLaunch({required this.sdkToken, required this.workflowRunId});

  final String sdkToken;
  final String workflowRunId;
}

class SmileIdLaunch extends KycLaunch {
  const SmileIdLaunch({required this.partnerId, required this.sandbox, required this.jobId, required this.userId, required this.jobType, required this.callbackUrl});

  final String partnerId;
  final bool sandbox;
  final String jobId;
  final String userId;

  /// 1 : vérification biométrique (pièce déclarée) ; 6 : vérification de document.
  final int jobType;
  final Uri callbackUrl;
}

class SessionSummary {
  const SessionSummary({required this.id, required this.audience, required this.deviceName, required this.lastUsedAt, required this.current});

  factory SessionSummary.fromJson(Json json) => SessionSummary(
        id: json.string('id'),
        audience: json.string('audience'),
        deviceName: json.optionalString('deviceName'),
        lastUsedAt: json.dateTime('lastUsedAt'),
        current: json.boolean('current'),
      );

  final String id;
  final String audience;
  final String? deviceName;
  final DateTime lastUsedAt;
  final bool current;
}

class DeviceSummary {
  const DeviceSummary({required this.id, required this.platform, required this.name, required this.createdAt, required this.current});

  factory DeviceSummary.fromJson(Json json) => DeviceSummary(
        id: json.string('id'),
        platform: json.string('platform'),
        name: json.string('name'),
        createdAt: json.dateTime('createdAt'),
        current: json.boolean('current'),
      );

  final String id;
  final String platform;
  final String name;
  final DateTime createdAt;
  final bool current;
}
