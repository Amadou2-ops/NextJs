import DeviceCheck
import Flutter
import Security
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "DeviceSecurityPlugin") {
      DeviceSecurityPlugin.register(with: registrar)
    }
  }
}

/// Clé de l'appareil dans la Secure Enclave (P-256, non exportable, liée à
/// cet appareil, jamais sauvegardée) et attestation de l'application par
/// App Attest, liée au condensat fourni par Dart (défi serveur ‖ empreinte
/// de la clé publique). Aucun repli logiciel : sans Secure Enclave ni App
/// Attest (simulateur), l'enregistrement de l'appareil est refusé.
final class DeviceSecurityPlugin: NSObject, FlutterPlugin {
  static let channelName = "com.transfertplus/device_security"
  private static let keyTag = Data("com.transfertplus.app.device_key_v1".utf8)
  /// En-tête SubjectPublicKeyInfo DER d'une clé EC P-256 non compressée.
  private static let p256SpkiHeader: [UInt8] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01,
    0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]

  static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(DeviceSecurityPlugin(), channel: channel)
  }

  func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let arguments = call.arguments as? [String: Any]
    switch call.method {
    case "createKey":
      respond(result) { try self.createKey() }
    case "publicKey":
      respond(result) { try self.loadPrivateKey().map { try self.spki(of: $0) } }
    case "sign":
      guard let message = (arguments?["message"] as? FlutterStandardTypedData)?.data else {
        result(FlutterError(code: "invalid_argument", message: "message manquant", details: nil))
        return
      }
      respond(result) { try self.sign(message) }
    case "deleteKey":
      respond(result) { self.deleteKey(); return nil }
    case "attest":
      guard let hash = (arguments?["clientDataHash"] as? FlutterStandardTypedData)?.data, hash.count == 32 else {
        result(FlutterError(code: "invalid_argument", message: "condensat de 32 octets attendu", details: nil))
        return
      }
      attest(clientDataHash: hash, result: result)
    case "describe":
      result(describe())
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func respond(_ result: FlutterResult, _ block: () throws -> Any?) {
    do {
      let value = try block()
      if let data = value as? Data {
        result(FlutterStandardTypedData(bytes: data))
      } else {
        result(value)
      }
    } catch let error as DeviceSecurityError {
      result(FlutterError(code: error.code, message: error.message, details: nil))
    } catch {
      result(FlutterError(code: "keychain_error", message: error.localizedDescription, details: nil))
    }
  }

  private func createKey() throws -> Data {
    deleteKey()
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .privateKeyUsage, &accessError) else {
      throw DeviceSecurityError(code: "keychain_error", message: "contrôle d'accès impossible : \(String(describing: accessError?.takeRetainedValue()))")
    }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: DeviceSecurityPlugin.keyTag,
        kSecAttrAccessControl as String: access,
      ],
    ]
    var createError: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &createError) else {
      throw DeviceSecurityError(code: "secure_enclave_unavailable", message: "Secure Enclave indisponible : \(String(describing: createError?.takeRetainedValue()))")
    }
    return try spki(of: privateKey)
  }

  private func loadPrivateKey() throws -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: DeviceSecurityPlugin.keyTag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let found = item else {
      throw DeviceSecurityError(code: "keychain_error", message: "lecture de la clé impossible (\(status))")
    }
    return (found as! SecKey)
  }

  private func spki(of privateKey: SecKey) throws -> Data {
    var exportError: Unmanaged<CFError>?
    guard let publicKey = SecKeyCopyPublicKey(privateKey),
          let raw = SecKeyCopyExternalRepresentation(publicKey, &exportError) as Data?, raw.count == 65 else {
      throw DeviceSecurityError(code: "keychain_error", message: "export de la clé publique impossible")
    }
    return Data(DeviceSecurityPlugin.p256SpkiHeader) + raw
  }

  private func sign(_ message: Data) throws -> Data {
    guard let privateKey = try loadPrivateKey() else {
      throw DeviceSecurityError(code: "key_missing", message: "clé d'appareil absente")
    }
    var signError: Unmanaged<CFError>?
    // ECDSA P-256 / SHA-256, signature X9.62 (DER).
    guard let signature = SecKeyCreateSignature(privateKey, .ecdsaSignatureMessageX962SHA256, message as CFData, &signError) as Data? else {
      throw DeviceSecurityError(code: "signature_failed", message: "signature impossible : \(String(describing: signError?.takeRetainedValue()))")
    }
    return signature
  }

  private func deleteKey() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: DeviceSecurityPlugin.keyTag,
    ]
    SecItemDelete(query as CFDictionary)
  }

  private func attest(clientDataHash: Data, result: @escaping FlutterResult) {
    let service = DCAppAttestService.shared
    guard service.isSupported else {
      result(FlutterError(code: "attestation_unavailable", message: "App Attest non pris en charge sur cet appareil", details: nil))
      return
    }
    service.generateKey { keyId, error in
      guard let keyId = keyId, error == nil else {
        DispatchQueue.main.async {
          result(FlutterError(code: "attestation_failed", message: error?.localizedDescription ?? "clé App Attest indisponible", details: nil))
        }
        return
      }
      service.attestKey(keyId, clientDataHash: clientDataHash) { attestation, error in
        DispatchQueue.main.async {
          guard let attestation = attestation, error == nil else {
            result(FlutterError(code: "attestation_failed", message: error?.localizedDescription ?? "attestation refusée", details: nil))
            return
          }
          // keyId est déjà en base64 (identifiant fourni par DeviceCheck).
          result(["type": "app_attest", "keyId": keyId, "attestationObject": attestation.base64EncodedString()])
        }
      }
    }
  }

  private func describe() -> [String: String] {
    var systemInfo = utsname()
    uname(&systemInfo)
    let model = withUnsafeBytes(of: &systemInfo.machine) { buffer in
      String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
    }
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    return [
      "platform": "ios",
      "name": "Apple \(model)",
      "osVersion": "iOS \(UIDevice.current.systemVersion)",
      "appVersion": version,
    ]
  }
}

struct DeviceSecurityError: Error {
  let code: String
  let message: String
}
