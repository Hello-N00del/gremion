import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Exclude the JVM tink artifact — tink-android supersedes it on Android.
// flutter_secure_storage uses tink-android; a JVM tink pulled in by any other
// dependency would cause hundreds of duplicate class errors.
configurations.all {
    exclude(group = "com.google.crypto.tink", module = "tink")
}

// Load signing config from android/key.properties if present (gitignored per .gitignore).
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}

android {
    namespace = "com.stura.stura"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "com.stura.app"
        // TRD-290: Android 10+ (API 29), a literal (TASK-166). targetSdk is TASK-179.
        minSdk = 29
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        // AppAuth redirect — custom scheme (not HTTPS App Links).
        //
        // G-051: custom URI schemes are interceptable. Any other Android app
        // declaring the same scheme in an <intent-filter> registers as a
        // handler. Mitigations (kept consistent with lib/services/auth_service.dart):
        //   - PKCE on by default (flutter_appauth v7+).
        //   - `state` parameter auto-generated and validated per authorize().
        //   - Wave 1 G-002 requires a real release keystore — narrows the
        //     attacker's blast radius to debug builds and sideloaded prod.
        // Migration to HTTPS App Links is blocked on flutter_appauth issues
        // #505/#546 (Android) and #566 (iOS). See
        // docs/specs/mobile-oidc-scheme-migration.md.
        manifestPlaceholders["appAuthRedirectScheme"] = "stura"
    }

    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                keyAlias      = keystoreProperties["keyAlias"] as String
                keyPassword   = keystoreProperties["keyPassword"] as String
                storeFile     = keystoreProperties["storeFile"]?.let { file(it as String) }
                storePassword = keystoreProperties["storePassword"] as String
            }
        }
    }

    buildTypes {
        release {
            // G-002: a real keystore is required to sign release builds. Only wire
            // it up when key.properties is present; the guard below fails release
            // builds that lack it — lazily, so debug/profile builds and plain
            // Gradle configuration (e.g. :app:tasks) still succeed without a key.
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled   = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

// G-002 (lazy): fail only when a release build is actually requested and no
// keystore is present. Evaluated once the task graph is ready — which happens
// for `assembleRelease`/`bundleRelease` (including under --dry-run) but not for
// benign, keyless tasks like `:app:tasks`, debug, or profile builds.
if (!keystorePropertiesFile.exists()) {
    gradle.taskGraph.whenReady {
        val needsReleaseSigning = allTasks.any {
            it.project == project && it.name.endsWith("Release")
        }
        if (needsReleaseSigning) {
            throw GradleException(
                "mobile/android/key.properties is required for release builds " +
                "(G-002). Local dev must use --debug or --profile, not --release. " +
                "CI must inject key.properties from secrets before invoking gradle."
            )
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    // Needed to compile the DefaultConnectionBuilder shadow class (same package as library)
    compileOnly("net.openid:appauth:0.11.1")
}
