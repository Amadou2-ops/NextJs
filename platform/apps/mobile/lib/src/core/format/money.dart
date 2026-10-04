import 'package:intl/intl.dart';

/// Montant en unités mineures (chaîne d'entiers, jamais de flottant), tel que
/// transmis par l'API.
class Money {
  Money(this.amountMinor, this.currency) {
    if (!_minorPattern.hasMatch(amountMinor)) throw FormatException('montant invalide', amountMinor);
    if (!_currencyPattern.hasMatch(currency)) throw FormatException('devise invalide', currency);
  }

  factory Money.fromJson(Object? json) {
    if (json is! Map<String, Object?>) throw const FormatException('montant attendu');
    final amount = json['amount'];
    final currency = json['currency'];
    if (amount is! String || currency is! String) throw const FormatException('montant attendu');
    return Money(amount, currency);
  }

  static final RegExp _minorPattern = RegExp(r'^-?\d{1,19}$');
  static final RegExp _currencyPattern = RegExp(r'^[A-Z]{3}$');

  final String amountMinor;
  final String currency;

  BigInt get minor => BigInt.parse(amountMinor);

  @override
  bool operator ==(Object other) => other is Money && other.amountMinor == amountMinor && other.currency == currency;

  @override
  int get hashCode => Object.hash(amountMinor, currency);

  @override
  String toString() => formatMoney(this);
}

const String _locale = 'fr_FR';
// Séparateurs français : espace fine insécable pour les milliers, virgule décimale.
const String _thousands = ' ';
const String _beforeSymbol = ' ';

/// Nombre de décimales de la devise (ISO 4217, données intl).
int currencyDigits(String currency) => NumberFormat.simpleCurrency(locale: _locale, name: currency).decimalDigits ?? 2;

String currencySymbol(String currency) => NumberFormat.simpleCurrency(locale: _locale, name: currency).currencySymbol;

/// Unités mineures signées → décimal exact en texte (« 1234.50 »).
String minorToDecimal(String amountMinor, int digits) {
  final match = RegExp(r'^(-?)(\d+)$').firstMatch(amountMinor);
  if (match == null) throw FormatException('montant invalide', amountMinor);
  final sign = match.group(1)!;
  final magnitude = match.group(2)!;
  if (digits == 0) return '$sign${_trimZeros(magnitude)}';
  final padded = magnitude.padLeft(digits + 1, '0');
  return '$sign${_trimZeros(padded.substring(0, padded.length - digits))}.${padded.substring(padded.length - digits)}';
}

String _trimZeros(String digits) {
  final trimmed = digits.replaceFirst(RegExp(r'^0+'), '');
  return trimmed.isEmpty ? '0' : trimmed;
}

/// Saisie décimale positive (virgule ou point, espaces tolérés) → unités
/// mineures ; null si invalide, nulle ou plus précise que la devise.
String? decimalToMinor(String input, int digits) {
  final normalized = input.trim().replaceAll(RegExp(r'[\s  ]'), '').replaceFirst(',', '.');
  final match = RegExp(r'^(\d{1,15})(?:\.(\d+))?$').firstMatch(normalized);
  if (match == null) return null;
  final fraction = match.group(2) ?? '';
  if (fraction.length > digits) return null;
  final minor = _trimZeros('${match.group(1)}${fraction.padRight(digits, '0')}');
  return minor == '0' ? null : minor;
}

/// Mise en forme exacte « 1 234,50 € » sans passer par un flottant.
String formatMoney(Money money) {
  final digits = currencyDigits(money.currency);
  final decimal = minorToDecimal(money.amountMinor, digits);
  final negative = decimal.startsWith('-');
  final unsigned = negative ? decimal.substring(1) : decimal;
  final parts = unsigned.split('.');
  final integer = parts[0];
  final grouped = StringBuffer();
  for (var index = 0; index < integer.length; index++) {
    if (index > 0 && (integer.length - index) % 3 == 0) grouped.write(_thousands);
    grouped.write(integer[index]);
  }
  final fraction = parts.length > 1 ? ',${parts[1]}' : '';
  return '${negative ? '-' : ''}$grouped$fraction$_beforeSymbol${currencySymbol(money.currency)}';
}

/// Taux exact « 1 EUR = 655,957 XOF » (6 décimales significatives au plus).
String formatRate(String rate, String source, String destination) {
  final parts = rate.split('.');
  final fraction = parts.length > 1 ? parts[1].substring(0, parts[1].length < 6 ? parts[1].length : 6).replaceFirst(RegExp(r'0+$'), '') : '';
  return '1 $source = ${parts[0]}${fraction.isEmpty ? '' : ',$fraction'} $destination';
}

final DateFormat _dateTime = DateFormat('d MMM y à HH:mm', _locale);

String formatDateTime(DateTime value) => _dateTime.format(value.toLocal());
