package com.transfertplus.app

import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine

/**
 * FlutterFragmentActivity : requise par Stripe (PaymentSheet), l'invite
 * biométrique (local_auth) et les SDK d'identité.
 */
class MainActivity : FlutterFragmentActivity() {
    private var deviceSecurity: DeviceSecurityChannel? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Données financières : pas de capture d'écran ni d'aperçu dans les applications récentes.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        deviceSecurity = DeviceSecurityChannel(applicationContext, flutterEngine.dartExecutor.binaryMessenger)
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        deviceSecurity?.dispose()
        deviceSecurity = null
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
