import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:transfertplus/src/core/format/money.dart';

void main() {
  setUpAll(() => initializeDateFormatting('fr_FR'));

  test('convertit unités mineures et décimal sans flottant, y compris les montants signés', () {
    expect(minorToDecimal('10199', 2), '101.99');
    expect(minorToDecimal('5', 2), '0.05');
    expect(minorToDecimal('-5', 2), '-0.05');
    expect(minorToDecimal('64611', 0), '64611');
    expect(minorToDecimal('123456789012345678', 2), '1234567890123456.78');
    expect(decimalToMinor('101,99', 2), '10199');
    expect(decimalToMinor('1 000', 0), '1000');
    expect(decimalToMinor('1 000,5', 2), '100050');
    expect(decimalToMinor('10.999', 2), isNull);
    expect(decimalToMinor('0', 2), isNull);
    expect(decimalToMinor('-5', 2), isNull);
    expect(decimalToMinor('1e3', 2), isNull);
  });

  test('formate selon les décimales ISO 4217 avec les séparateurs français', () {
    expect(formatMoney(Money('10199', 'EUR')), '101,99 €');
    expect(formatMoney(Money('123456789', 'EUR')), '1 234 567,89 €');
    expect(formatMoney(Money('64611', 'XOF')), startsWith('64 611 '));
    expect(formatMoney(Money('-250', 'EUR')), '-2,50 €');
    expect(currencyDigits('XOF'), 0);
    expect(currencyDigits('EUR'), 2);
  });

  test('refuse un montant ou une devise mal formés', () {
    expect(() => Money('1.5', 'EUR'), throwsFormatException);
    expect(() => Money('100', 'eur'), throwsFormatException);
    expect(() => Money.fromJson({'amount': 100, 'currency': 'EUR'}), throwsFormatException);
  });

  test('affiche un taux exact tronqué à 6 décimales', () {
    expect(formatRate('655.957000000000', 'EUR', 'XOF'), '1 EUR = 655,957 XOF');
    expect(formatRate('1', 'EUR', 'EUR'), '1 EUR = 1 EUR');
  });
}
