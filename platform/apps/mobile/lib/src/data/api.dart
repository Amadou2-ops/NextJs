import 'package:uuid/uuid.dart';

import '../core/api/api_client.dart';
import '../core/api/api_exception.dart';
import '../core/api/json.dart';
import '../core/session/session_manager.dart';
import 'models.dart';

/// Accès typé aux routes de l'API utilisées par l'application.

class AuthApi {
  const AuthApi(this._api, this._session);

  final ApiClient _api;
  final SessionManager _session;

  Future<String> startRegistration({required String phone, required String countryHint}) async {
    final json = asObject(await _api.send(HttpMethod.post, '/v1/auth/registration/start', body: {'phone': phone, 'countryHint': countryHint, 'locale': 'fr'}, authenticated: false));
    return json.string('challengeId');
  }

  Future<void> completeRegistration({required String challengeId, required String code, required String phone, required String password, required String countryOfResidence}) async {
    final json = await _withDevice(
      (client) => _api.send(
        HttpMethod.post,
        '/v1/auth/registration/complete',
        body: {'challengeId': challengeId, 'code': code, 'phone': phone, 'password': password, 'countryOfResidence': countryOfResidence, 'preferredLocale': 'fr', 'client': client},
        authenticated: false,
      ),
    );
    await _session.adopt(AuthenticatedSession.fromJson(asObject(json)));
  }

  /// Mot de passe oublié : réponse identique qu'un compte existe ou non.
  Future<String> startPasswordReset({required String phone, required String countryHint}) async {
    final json = asObject(await _api.send(HttpMethod.post, '/v1/auth/password-reset/start', body: {'phone': phone, 'countryHint': countryHint, 'locale': 'fr'}, authenticated: false));
    return json.string('challengeId');
  }

  /// Remplace le mot de passe ; toutes les sessions du compte sont fermées.
  Future<void> completePasswordReset({required String challengeId, required String code, required String phone, required String countryHint, required String password, String? totpCode}) async {
    await _api.send(
      HttpMethod.post,
      '/v1/auth/password-reset/complete',
      body: {'challengeId': challengeId, 'code': code, 'phone': phone, 'countryHint': countryHint, 'password': password, 'totpCode': ?totpCode},
      authenticated: false,
    );
  }

  /// Appareil de confiance : la requête signée tient lieu de second facteur.
  /// Nouvel appareil : attestation puis code SMS ou TOTP.
  Future<LoginOutcome> login({required String phone, required String password}) async {
    final json = asObject(await _withDevice((client) {
      final deviceId = client['deviceId'];
      return _api.send(
        HttpMethod.post,
        '/v1/auth/login',
        body: {'phone': phone, 'password': password, 'client': client},
        authenticated: false,
        signed: deviceId is String,
        signingDeviceId: deviceId is String ? deviceId : null,
      );
    }));
    if (json.string('status') == 'second_factor_required') {
      return LoginSecondFactor(loginChallengeId: json.string('loginChallengeId'), method: json.oneOf('method', SecondFactorMethod.values));
    }
    final session = AuthenticatedSession.fromJson(json);
    await _session.adopt(session);
    return LoginAuthenticated(session);
  }

  Future<void> verifyLogin({required String loginChallengeId, required String code}) async {
    final json = asObject(await _api.send(HttpMethod.post, '/v1/auth/login/verify', body: {'loginChallengeId': loginChallengeId, 'code': code}, authenticated: false));
    await _session.adopt(AuthenticatedSession.fromJson(json));
  }

  /// Un appareil révoqué côté API est oublié, puis la requête est refaite
  /// avec un nouvel appareil attesté (une seule fois).
  Future<Json?> _withDevice(Future<Json?> Function(Map<String, Object?> client) call) async {
    try {
      return await call(await _session.clientDescriptor());
    } on ApiException catch (error) {
      if (error.code != 'DEVICE_SIGNATURE_INVALID') rethrow;
      await _session.deviceRejected();
      return call(await _session.clientDescriptor());
    }
  }
}

class QuoteRequest {
  const QuoteRequest({
    required this.destinationCountry,
    required this.sourceCurrency,
    required this.destinationCurrency,
    required this.payoutMethod,
    required this.fundingMethod,
    required this.amountMinor,
    required this.amountType,
  });

  final String destinationCountry;
  final String sourceCurrency;
  final String destinationCurrency;
  final PayoutMethod payoutMethod;
  final FundingMethod fundingMethod;
  final String amountMinor;

  /// "send" ou "receive"
  final String amountType;

  Map<String, Object?> toJson() => {
        'destinationCountry': destinationCountry,
        'sourceCurrency': sourceCurrency,
        'destinationCurrency': destinationCurrency,
        'payoutMethod': payoutMethod.wire,
        'fundingMethod': fundingMethod.wire,
        'amount': amountMinor,
        'amountType': amountType,
      };
}

class TransfersApi {
  const TransfersApi(this._api);

  final ApiClient _api;

  /// Devis garanti (taux et frais figés jusqu'à expiration).
  Future<Quote> quote(QuoteRequest request) async => Quote.fromJson(asObject(await _api.send(HttpMethod.post, '/v1/quotes', body: request.toJson())));

  /// Création signée par l'appareil ; [idempotencyKey] est conservée par
  /// l'écran : une nouvelle tentative rejoue le même transfert, jamais un second.
  Future<({Transfer transfer, FundingAction? funding})> create({
    required String quoteId,
    required String recipientId,
    required String purposeCode,
    required String idempotencyKey,
  }) async {
    final json = asObject(await _api.send(
      HttpMethod.post,
      '/v1/transfers',
      body: {'quoteId': quoteId, 'recipientId': recipientId, 'purposeCode': purposeCode},
      signed: true,
      idempotencyKey: idempotencyKey,
    ));
    return (transfer: Transfer.fromJson(json.object('transfer')), funding: FundingAction.fromJson(json['funding']));
  }

  static String newIdempotencyKey() => 'mob-${const Uuid().v4()}';

  Future<({List<Transfer> transfers, String? nextCursor})> list({String? before, int limit = 20}) async {
    final json = asObject(await _api.send(HttpMethod.get, '/v1/transfers', query: {'limit': '$limit', 'before': ?before}));
    return (transfers: [for (final item in json.objects('transfers')) Transfer.fromJson(item)], nextCursor: json.optionalString('nextCursor'));
  }

  Future<Transfer> get(String id) async => Transfer.fromJson(asObject(await _api.send(HttpMethod.get, '/v1/transfers/$id')));

  Future<FundingAction?> funding(String id) async => FundingAction.fromJson(asObject(await _api.send(HttpMethod.get, '/v1/transfers/$id/funding'))['funding']);

  Future<Transfer> cancel(String id) async => Transfer.fromJson(asObject(await _api.send(HttpMethod.post, '/v1/transfers/$id/cancel', signed: true)));
}

class RecipientsApi {
  const RecipientsApi(this._api);

  final ApiClient _api;

  Future<List<Recipient>> list() async => [for (final item in asObject(await _api.send(HttpMethod.get, '/v1/recipients')).objects('recipients')) Recipient.fromJson(item)];

  Future<Recipient> create({
    required String country,
    required String currency,
    required String firstName,
    required String lastName,
    required String relationship,
    required Map<String, String> account,
  }) async =>
      Recipient.fromJson(asObject(await _api.send(
        HttpMethod.post,
        '/v1/recipients',
        body: {'country': country, 'currency': currency, 'firstName': firstName, 'lastName': lastName, 'relationship': relationship, 'account': account},
        signed: true,
      )));

  Future<void> archive(String id) async => _api.send(HttpMethod.delete, '/v1/recipients/$id', signed: true);
}

class WalletApi {
  const WalletApi(this._api);

  final ApiClient _api;

  Future<List<Wallet>> wallets() async => [for (final item in asObject(await _api.send(HttpMethod.get, '/v1/wallets')).objects('wallets')) Wallet.fromJson(item)];

  /// Ouverture d'un portefeuille : réservée à l'application (requête signée par la clé de l'appareil).
  Future<Wallet> open(String currency) async => Wallet.fromJson(asObject(await _api.send(HttpMethod.post, '/v1/wallets', body: {'currency': currency}, signed: true)));

  Future<({List<StatementEntry> entries, String? nextCursor})> statement(String currency, {String? before}) async {
    final json = asObject(await _api.send(HttpMethod.get, '/v1/wallets/$currency/statement', query: {'limit': '50', 'before': ?before}));
    return (entries: [for (final item in json.objects('entries')) StatementEntry.fromJson(item)], nextCursor: json.optionalString('nextCursor'));
  }
}

class KycApi {
  const KycApi(this._api);

  final ApiClient _api;

  Future<KycOverview> overview() async => KycOverview.fromJson(asObject(await _api.send(HttpMethod.get, '/v1/kyc')));

  Future<({KycVerification verification, KycLaunch launch})> start({required KycTier tier, ({String firstName, String lastName, String dateOfBirth})? declared}) async {
    final json = asObject(await _api.send(
      HttpMethod.post,
      '/v1/kyc/verifications',
      body: {
        'tier': tier.wire,
        if (declared != null) 'declaredIdentity': {'firstName': declared.firstName, 'lastName': declared.lastName, 'dateOfBirth': declared.dateOfBirth},
      },
      signed: true,
    ));
    return (verification: KycVerification.fromJson(json.object('verification')), launch: KycLaunch.fromJson(json.object('launch')));
  }

  Future<KycVerification> markSubmitted(String verificationId) async =>
      KycVerification.fromJson(asObject(await _api.send(HttpMethod.post, '/v1/kyc/verifications/$verificationId/submitted', signed: true)));
}

class SecurityApi {
  const SecurityApi(this._api);

  final ApiClient _api;

  Future<List<SessionSummary>> sessions() async => [for (final item in asObject(await _api.send(HttpMethod.get, '/v1/auth/sessions')).objects('sessions')) SessionSummary.fromJson(item)];

  Future<void> revokeSession(String id) async => _api.send(HttpMethod.delete, '/v1/auth/sessions/$id', signed: true);

  Future<int> revokeOtherSessions() async => asObject(await _api.send(HttpMethod.post, '/v1/auth/sessions/revoke-others', signed: true)).integer('revoked');

  Future<List<DeviceSummary>> devices() async => [for (final item in asObject(await _api.send(HttpMethod.get, '/v1/auth/devices')).objects('devices')) DeviceSummary.fromJson(item)];

  Future<void> revokeDevice(String id) async => _api.send(HttpMethod.delete, '/v1/auth/devices/$id', signed: true);

  Future<({String secret, Uri otpauthUri})> startTotp() async {
    final json = asObject(await _api.send(HttpMethod.post, '/v1/auth/mfa/totp/setup', signed: true));
    return (secret: json.string('secret'), otpauthUri: Uri.parse(json.string('otpauthUri')));
  }

  Future<void> confirmTotp(String code) async => _api.send(HttpMethod.post, '/v1/auth/mfa/totp/confirm', body: {'code': code}, signed: true);

  Future<void> disableTotp(String code) async => _api.send(HttpMethod.post, '/v1/auth/mfa/totp/disable', body: {'code': code}, signed: true);
}

