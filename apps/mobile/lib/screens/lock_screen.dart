// mobile/lib/screens/lock_screen.dart
//
// PR 6 T6.10 (G-092) — foreground app-lock UI. Shown by app.dart when the app
// returns from background/inactive. The UI gate is intentionally lightweight:
// tapping "Entsperren" clears the gate via [onUnlock]; the underlying
// Keycloak/Matrix session is untouched (it refreshes via AuthService as today).
import 'package:flutter/material.dart';
import 'package:stura/brand.dart';
import 'package:stura/tokens/design_tokens.dart';

class LockScreen extends StatelessWidget {
  /// Invoked when the user dismisses the lock (e.g. taps "Entsperren" or a
  /// future biometric prompt succeeds). Null in tests that only assert layout.
  final VoidCallback? onUnlock;

  const LockScreen({super.key, this.onUnlock});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: GremionTokens.paperDark,
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Container(
                width: 64,
                height: 64,
                decoration: const BoxDecoration(
                  color: GremionTokens.accentDark,
                  borderRadius: GremionTokens.rMd,
                ),
                alignment: Alignment.center,
                child: const Text(
                  'S',
                  style: TextStyle(
                    fontFamily: GremionTokens.fontDisplay,
                    fontWeight: FontWeight.w700,
                    fontSize: 32,
                    color: GremionTokens.paperDark,
                  ),
                ),
              ),
              const SizedBox(height: GremionTokens.s4),
              const Text(
                Brand.product,
                style: TextStyle(
                  fontFamily: GremionTokens.fontDisplay,
                  fontSize: 26,
                  fontWeight: FontWeight.w500,
                  color: GremionTokens.inkDark,
                ),
              ),
              const SizedBox(height: GremionTokens.s2),
              const Text(
                'Gesperrt — zur Sicherheit erneut entsperren.',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontFamily: GremionTokens.fontBody,
                  fontSize: 13.5,
                  color: GremionTokens.inkMutedDark,
                ),
              ),
              const SizedBox(height: GremionTokens.s8),
              SizedBox(
                width: 240,
                height: GremionTokens.touchTargetMin,
                child: ElevatedButton.icon(
                  onPressed: onUnlock,
                  icon: const Icon(Icons.lock_open_outlined, size: 18),
                  label: const Text('Entsperren'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: GremionTokens.accentDark,
                    foregroundColor: GremionTokens.paperDark,
                    elevation: 0,
                    shape: const RoundedRectangleBorder(
                      borderRadius: GremionTokens.rMd,
                    ),
                    textStyle: const TextStyle(
                      fontFamily: GremionTokens.fontBody,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
