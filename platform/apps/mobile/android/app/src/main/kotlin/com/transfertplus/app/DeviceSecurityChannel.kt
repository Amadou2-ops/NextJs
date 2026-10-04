package com.transfertplus.app

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.Executors

/**
 * Clé de l'appareil dans l'Android Keystore (StrongBox si disponible, sinon
 * TEE) : P-256, usage signature uniquement, non exportable. Attestation de
 * l'application par l'API Play Integrity (requête « standard ») liée au
 * condensat fourni par Dart (défi serveur ‖ empreinte de la clé publique).
 */
class DeviceSecurityChannel(private val context: Context, messenger: BinaryMessenger) : MethodChannel.MethodCallHandler {
    private val channel = MethodChannel(messenger, CHANNEL)
    // Les opérations du Keystore peuvent être lentes (StrongBox) : hors du fil principal.
    private val worker = Executors.newSingleThreadExecutor()

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "createKey" -> background(result) { createKey() }
            "publicKey" -> background(result) { publicKey() }
            "sign" -> {
                val message = call.argument<ByteArray>("message")
                if (message == null) {
                    result.error("invalid_argument", "message manquant", null)
                    return
                }
                background(result) { sign(message) }
            }
            "deleteKey" -> background(result) { deleteKey(); null }
            "attest" -> {
                val hash = call.argument<ByteArray>("clientDataHash")
                val project = call.argument<Number>("cloudProjectNumber")?.toLong()
                if (hash == null || hash.size != 32) {
                    result.error("invalid_argument", "condensat de 32 octets attendu", null)
                    return
                }
                if (project == null) {
                    result.error("attestation_unavailable", "PLAY_INTEGRITY_CLOUD_PROJECT non configuré", null)
                    return
                }
                attest(hash, project, result)
            }
            "describe" -> result.success(describe())
            else -> result.notImplemented()
        }
    }

    private fun background(result: MethodChannel.Result, block: () -> Any?) {
        worker.execute {
            try {
                val value = block()
                postResult { result.success(value) }
            } catch (error: Exception) {
                postResult { result.error("keystore_error", error.message ?: error.javaClass.simpleName, null) }
            }
        }
    }

    private fun postResult(action: () -> Unit) {
        android.os.Handler(android.os.Looper.getMainLooper()).post(action)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun createKey(): ByteArray {
        val store = keyStore()
        if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS)
        return try {
            generate(strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE))
        } catch (error: StrongBoxUnavailableException) {
            generate(strongBox = false)
        }
    }

    private fun generate(strongBox: Boolean): ByteArray {
        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        generator.initialize(spec)
        // Encodage X.509 SubjectPublicKeyInfo (DER), attendu par l'API.
        return generator.generateKeyPair().public.encoded
    }

    private fun publicKey(): ByteArray? = keyStore().getCertificate(KEY_ALIAS)?.publicKey?.encoded

    private fun sign(message: ByteArray): ByteArray {
        val key = keyStore().getKey(KEY_ALIAS, null) as? PrivateKey ?: throw IllegalStateException("clé d'appareil absente")
        // ECDSA P-256 / SHA-256, signature au format DER.
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(key)
            update(message)
            sign()
        }
    }

    private fun deleteKey() {
        val store = keyStore()
        if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS)
    }

    private fun attest(clientDataHash: ByteArray, cloudProjectNumber: Long, result: MethodChannel.Result) {
        val manager = IntegrityManagerFactory.createStandard(context.applicationContext)
        manager.prepareIntegrityToken(PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(cloudProjectNumber).build())
            .addOnSuccessListener { provider ->
                val requestHash = Base64.encodeToString(clientDataHash, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
                provider.request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build())
                    .addOnSuccessListener { response -> result.success(mapOf("type" to "play_integrity", "integrityToken" to response.token())) }
                    .addOnFailureListener { error -> result.error("attestation_failed", error.message ?: "jeton d'intégrité refusé", null) }
            }
            .addOnFailureListener { error -> result.error("attestation_failed", error.message ?: "Play Integrity indisponible", null) }
    }

    private fun describe(): Map<String, String> {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return mapOf(
            "platform" to "android",
            "name" to "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            "osVersion" to "Android ${Build.VERSION.RELEASE}",
            "appVersion" to (info.versionName ?: "0.0.0"),
        )
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
        worker.shutdown()
    }

    companion object {
        const val CHANNEL = "com.transfertplus/device_security"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "transfertplus_device_key_v1"
    }
}
