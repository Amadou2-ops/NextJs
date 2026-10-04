import 'package:flutter_test/flutter_test.dart';
import 'package:transfertplus/src/config.dart';

AppConfig parse({String api = 'https://api.transfertplus.com', String project = '', String partner = '', String token = '', String sandbox = '', bool release = true}) =>
    AppConfig.parse(apiBaseUrl: api, playIntegrityCloudProject: project, smileIdPartnerId: partner, smileIdAuthToken: token, smileIdSandbox: sandbox, release: release);

void main() {
  test('accepte une origine https et les identifiants des prestataires', () {
    final config = parse(project: '123456789', partner: '1234', token: 'jeton');
    expect(config.apiBaseUrl.toString(), 'https://api.transfertplus.com');
    expect(config.playIntegrityCloudProject, 123456789);
    expect(config.smileIdConfigured, isTrue);
  });

  test('exige https hors développement local, et une origine sans chemin', () {
    expect(() => parse(api: 'http://api.transfertplus.com'), throwsA(isA<ConfigurationError>()));
    expect(() => parse(api: 'http://10.0.2.2:8080'), throwsA(isA<ConfigurationError>()));
    expect(parse(api: 'http://10.0.2.2:8080', release: false).apiBaseUrl.port, 8080);
    expect(() => parse(api: 'http://evil.example', release: false), throwsA(isA<ConfigurationError>()));
    expect(() => parse(api: 'https://api.transfertplus.com/api'), throwsA(isA<ConfigurationError>()));
    expect(() => parse(api: 'https://user:pass@api.transfertplus.com'), throwsA(isA<ConfigurationError>()));
    expect(() => parse(api: ''), throwsA(isA<ConfigurationError>()));
  });

  test('refuse une configuration incohérente des prestataires', () {
    expect(() => parse(project: 'abc'), throwsA(isA<ConfigurationError>()));
    expect(() => parse(partner: '1234'), throwsA(isA<ConfigurationError>()));
    expect(() => parse(partner: '1234', token: 'x', sandbox: 'true'), throwsA(isA<ConfigurationError>()));
    expect(parse(partner: '1234', token: 'x', sandbox: 'true', release: false).smileIdSandbox, isTrue);
  });
}
