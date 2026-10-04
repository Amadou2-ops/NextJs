import 'package:flutter/material.dart';
import 'package:onfido_sdk/onfido_sdk.dart';
import 'package:smile_id/generated/smileid_messages.g.dart';
import 'package:smile_id/products/biometric/smile_id_biometric_kyc.dart';
import 'package:smile_id/products/document/smile_id_document_verification.dart';
import 'package:smile_id/smile_id.dart';

import '../../app_services.dart';
import '../../core/format/money.dart';
import '../../data/catalog.dart';
import '../../data/models.dart';
import '../widgets/common.dart';

/// Vérification d'identité : la session de capture est ouverte par l'API
/// (prestataire selon le pays), la capture faite par le SDK natif, puis la
/// fin de capture signalée. La décision arrive par webhook signé ; le niveau
/// est relevé par la base, jamais par l'application.
class KycScreen extends StatefulWidget {
  const KycScreen({super.key});

  @override
  State<KycScreen> createState() => _KycScreenState();
}

class _KycScreenState extends State<KycScreen> {
  final _firstName = TextEditingController();
  final _lastName = TextEditingController();
  final _birthDate = TextEditingController();
  bool _busy = false;
  String? _error;
  String? _info;
  int _generation = 0;

  @override
  void dispose() {
    _firstName.dispose();
    _lastName.dispose();
    _birthDate.dispose();
    super.dispose();
  }

  Future<void> _start(KycTier tier) async {
    final services = context.services;
    final navigator = Navigator.of(context);
    final declared = _firstName.text.trim().isNotEmpty && _lastName.text.trim().isNotEmpty && RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(_birthDate.text.trim())
        ? (firstName: _firstName.text.trim(), lastName: _lastName.text.trim(), dateOfBirth: _birthDate.text.trim())
        : null;
    setState(() {
      _busy = true;
      _error = null;
      _info = null;
    });
    try {
      final started = await services.kyc.start(tier: tier, declared: declared);
      final captured = switch (started.launch) {
        OnfidoLaunch(:final sdkToken, :final workflowRunId) => await _onfido(sdkToken, workflowRunId),
        final SmileIdLaunch launch => await _smileId(navigator, launch),
      };
      if (captured) {
        await services.kyc.markSubmitted(started.verification.id);
        if (mounted) setState(() => _info = 'Documents transmis : la vérification est en cours.');
      } else if (mounted) {
        setState(() => _info = 'Vérification interrompue : vous pourrez la reprendre plus tard.');
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = describeError(error));
    } finally {
      if (mounted) {
        setState(() {
          _busy = false;
          _generation++;
        });
      }
    }
  }

  Future<bool> _onfido(String sdkToken, String workflowRunId) async {
    try {
      await Onfido(sdkToken: sdkToken).startWorkflow(workflowRunId);
      return true;
    } on Exception {
      // Capture annulée ou échouée côté SDK : rien n'est signalé à l'API.
      return false;
    }
  }

  Future<bool> _smileId(NavigatorState navigator, SmileIdLaunch launch) async {
    final config = context.services.config;
    if (!config.smileIdConfigured || config.smileIdPartnerId != launch.partnerId) {
      throw StateError('Smile ID non configuré pour ce partenaire');
    }
    await SmileID.initializeWithConfig(
      config: FlutterConfig(
        partnerId: launch.partnerId,
        authToken: config.smileIdAuthToken!,
        prodBaseUrl: 'https://api.smileidentity.com/',
        sandboxBaseUrl: 'https://testapi.smileidentity.com/',
      ),
      useSandbox: launch.sandbox,
      enableCrashReporting: false,
    );
    SmileID.setCallbackUrl(callbackUrl: launch.callbackUrl);
    final result = await navigator.push<bool>(MaterialPageRoute(builder: (_) => _SmileIdCapture(launch: launch)));
    return result ?? false;
  }

  @override
  Widget build(BuildContext context) {
    final services = context.services;
    return Scaffold(
      appBar: AppBar(title: const Text('Vérification d\'identité')),
      body: Loader<KycOverview>(
        key: ValueKey(_generation),
        load: services.kyc.overview,
        builder: (context, overview, reload) => ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (_error != null) ErrorBanner(_error!),
            if (_info != null) InfoBanner(_info!),
            SummaryRow('Niveau actuel', kycTierLabel(overview.tier), emphasized: true),
            SummaryRow('Plafond par transfert', formatMoney(overview.singleTransferMax)),
            SummaryRow('Plafond mensuel', formatMoney(overview.monthlyMax)),
            const SizedBox(height: 16),
            if (overview.activeVerification case final active?)
              InfoBanner('Vérification ${kycStatusLabel(active.status).toLowerCase()} (${formatDateTime(active.createdAt)}).')
            else if (overview.nextTier case final next?) ...[
              Text('Passez au niveau « ${kycTierLabel(next)} » pour relever vos plafonds.', style: Theme.of(context).textTheme.titleSmall),
              const SizedBox(height: 12),
              const Text('Identité telle qu\'elle figure sur votre pièce (facultatif, accélère la vérification) :'),
              TextField(controller: _firstName, decoration: const InputDecoration(labelText: 'Prénom(s)')),
              TextField(controller: _lastName, decoration: const InputDecoration(labelText: 'Nom')),
              TextField(controller: _birthDate, keyboardType: TextInputType.datetime, decoration: const InputDecoration(labelText: 'Date de naissance (AAAA-MM-JJ)')),
              const SizedBox(height: 16),
              if (overview.attemptsRemaining <= 0)
                const ErrorBanner('Nombre de tentatives atteint : contactez le service client.')
              else
                BusyButton(label: 'Commencer la vérification', busy: _busy, onPressed: () => _start(next)),
            ] else
              const InfoBanner('Votre identité est entièrement vérifiée.'),
          ],
        ),
      ),
    );
  }
}

/// Capture Smile ID (vues natives), selon le type de contrôle choisi par l'API.
class _SmileIdCapture extends StatefulWidget {
  const _SmileIdCapture({required this.launch});

  final SmileIdLaunch launch;

  @override
  State<_SmileIdCapture> createState() => _SmileIdCaptureState();
}

class _SmileIdCaptureState extends State<_SmileIdCapture> {
  static const _idTypes = {'NATIONAL_ID': "Carte nationale d'identité", 'PASSPORT': 'Passeport', 'DRIVERS_LICENSE': 'Permis de conduire', 'VOTER_ID': "Carte d'électeur"};

  String _country = corridors.first.country;
  String _idType = _idTypes.keys.first;
  final _idNumber = TextEditingController();
  bool _capturing = false;

  @override
  void dispose() {
    _idNumber.dispose();
    super.dispose();
  }

  void _finish(bool success) {
    if (mounted) Navigator.of(context).pop(success);
  }

  @override
  Widget build(BuildContext context) {
    final launch = widget.launch;
    final consentDate = DateTime.now().toUtc().toIso8601String();
    Widget body;
    if (!_capturing) {
      body = ListView(
        padding: const EdgeInsets.all(20),
        children: [
          DropdownButtonFormField<String>(
            isExpanded: true,
            initialValue: _country,
            decoration: const InputDecoration(labelText: 'Pays émetteur de la pièce'),
            items: [for (final corridor in corridors) DropdownMenuItem(value: corridor.country, child: Text(corridor.name))],
            onChanged: (value) => setState(() => _country = value ?? _country),
          ),
          if (launch.jobType == 1) ...[
            DropdownButtonFormField<String>(
              isExpanded: true,
              initialValue: _idType,
              decoration: const InputDecoration(labelText: 'Type de pièce'),
              items: [for (final entry in _idTypes.entries) DropdownMenuItem(value: entry.key, child: Text(entry.value))],
              onChanged: (value) => setState(() => _idType = value ?? _idType),
            ),
            TextField(controller: _idNumber, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Numéro de la pièce')),
          ],
          const SizedBox(height: 20),
          FilledButton(
            onPressed: launch.jobType == 1 && _idNumber.text.trim().isEmpty ? null : () => setState(() => _capturing = true),
            child: const Text('Commencer la capture'),
          ),
        ],
      );
    } else if (launch.jobType == 1) {
      body = SmileIDBiometricKYC(
        country: _country,
        idType: _idType,
        idNumber: _idNumber.text.trim(),
        userId: launch.userId,
        jobId: launch.jobId,
        consentGrantedDate: consentDate,
        personalDetailsConsentGranted: true,
        contactInformationConsentGranted: true,
        documentInformationConsentGranted: true,
        onSuccess: (_) => _finish(true),
        onError: (_) => _finish(false),
      );
    } else {
      body = SmileIDDocumentVerification(
        countryCode: _country,
        userId: launch.userId,
        jobId: launch.jobId,
        onSuccess: (_) => _finish(true),
        onError: (_) => _finish(false),
      );
    }
    return Scaffold(appBar: AppBar(title: const Text('Capture de la pièce')), body: body);
  }
}
