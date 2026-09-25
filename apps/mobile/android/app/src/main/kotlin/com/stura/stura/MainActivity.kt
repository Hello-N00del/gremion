package com.stura.stura

import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // #261: FLAG_SECURE deterministically blanks the recents/app-switcher
        // snapshot and blocks screenshots + media-projection screen recording
        // of E2EE chats, finance KPIs and council files. Applied to non-
        // debuggable (release) builds only, so debug tooling and emulator
        // captures still work during development. This backs the Flutter-level
        // LockScreen gate (app.dart) with an OS-level guarantee that isn't
        // subject to the lock-rebuild frame race.
        //
        // The debuggable check uses ApplicationInfo.FLAG_DEBUGGABLE rather than
        // BuildConfig.DEBUG so it does not depend on the buildConfig feature
        // being enabled for this module.
        val isDebuggable =
            (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!isDebuggable) {
            window.setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE,
            )
        }
    }
}
