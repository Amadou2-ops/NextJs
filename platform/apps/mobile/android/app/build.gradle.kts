import java.util.Properties

plugins {
    id("com.android.application")
    // Le plugin Flutter s'applique après les plugins Android et Kotlin.
    id("dev.flutter.flutter-gradle-plugin")
}

// Signature de production : android/key.properties (jamais versionné), voir README.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("key.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}
val releaseRequested = gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }

android {
    namespace = "com.transfertplus.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.transfertplus.app"
        // Android 9 : StrongBox, Keystore matériel et API Play Integrity standard.
        minSdk = 28
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            if (keystoreProperties.isNotEmpty()) {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (releaseRequested && keystoreProperties.isEmpty) {
                throw GradleException("Build de production : android/key.properties est requis (aucune signature avec la clé de débogage).")
            }
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

dependencies {
    implementation("com.google.android.play:integrity:1.4.0")
}

// Les SDK KYC tirent BouncyCastle sous deux variantes (jdk15to18 et jdk18on) qui
// contiennent les mêmes classes : la vérification des classes dupliquées échoue.
// La variante jdk15to18 est remplacée par jdk18on, dans la version déjà résolue.
val bouncyCastleVersion = "1.84"
configurations.configureEach {
    resolutionStrategy.dependencySubstitution {
        listOf("bcprov", "bcpkix", "bcutil", "bcpg").forEach { artifact ->
            substitute(module("org.bouncycastle:$artifact-jdk15to18"))
                .using(module("org.bouncycastle:$artifact-jdk18on:$bouncyCastleVersion"))
                .because("une seule variante de BouncyCastle dans l'application")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
