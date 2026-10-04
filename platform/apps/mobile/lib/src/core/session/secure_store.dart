import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Stockage clé-valeur chiffré par le système (Keychain iOS, Keystore Android).
abstract interface class SecureStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class PlatformSecureStore implements SecureStore {
  PlatformSecureStore()
      : _storage = const FlutterSecureStorage(
          // Jamais sauvegardé ni restauré sur un autre appareil : les secrets
          // sont liés à la clé matérielle de CET appareil.
          aOptions: AndroidOptions(migrateWithBackup: false),
          iOptions: IOSOptions(accessibility: KeychainAccessibility.unlocked_this_device, synchronizable: false),
        );

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) => _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// Clés du stockage sécurisé.
abstract final class StoreKeys {
  static const refreshToken = 'tp.refresh_token';
  static const deviceId = 'tp.device_id';
  static const deviceCounter = 'tp.device_counter';
  static const userId = 'tp.user_id';
  static const sourceCurrency = 'tp.source_currency';
}
