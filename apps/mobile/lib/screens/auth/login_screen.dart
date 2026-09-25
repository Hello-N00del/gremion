// mobile/lib/screens/auth/login_screen.dart
//
// PR 6 T6.2 — login screen ported to the 2026-05-28 bundle layout (MLogin):
// rounded logo tile, display-font "Willkommen zurück." headline, muted
// subtitle, a single SSO/sign-in action, and a mono footer. Consumes
// GremionTokens directly. Behaviour (OIDC login via AuthService, loading/error
// state) is unchanged from the pre-refresh screen.
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../services/auth_service.dart';
import '../../tokens/design_tokens.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  bool _loading = false;
  String? _error;

  Future<void> _login() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await context.read<AuthService>().login();
    } catch (e) {
      setState(() {
        _error = e.toString();
      });
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: GremionTokens.paperDark,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(
              horizontal: GremionTokens.s7,
              vertical: GremionTokens.s6,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Logo tile (MLogin .m-login-logo).
                Container(
                  width: 56,
                  height: 56,
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
                      fontSize: 28,
                      color: GremionTokens.paperDark,
                    ),
                  ),
                ),
                const SizedBox(height: GremionTokens.s6),
                const Text(
                  'Willkommen zurück.',
                  style: TextStyle(
                    fontFamily: GremionTokens.fontDisplay,
                    fontSize: 30,
                    fontWeight: FontWeight.w500,
                    letterSpacing: -0.5,
                    color: GremionTokens.inkDark,
                  ),
                ),
                const SizedBox(height: GremionTokens.s2),
                const Text(
                  'Melde dich mit deiner Hochschul-ID an.',
                  style: TextStyle(
                    fontFamily: GremionTokens.fontBody,
                    fontSize: 14.5,
                    color: GremionTokens.inkMutedDark,
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: GremionTokens.s8),
                if (_error != null) ...[
                  Container(
                    padding: const EdgeInsets.all(GremionTokens.s4),
                    decoration: BoxDecoration(
                      color: GremionTokens.rustSoftDark,
                      borderRadius: GremionTokens.rMd,
                      border: Border.all(color: GremionTokens.borderDark),
                    ),
                    child: Text(
                      _error!,
                      style: const TextStyle(
                        fontFamily: GremionTokens.fontBody,
                        fontSize: 13.5,
                        color: GremionTokens.rustInkDark,
                        height: 1.4,
                      ),
                    ),
                  ),
                  const SizedBox(height: GremionTokens.s4),
                ],
                // SSO sign-in action (MLogin .sso / .btn-big).
                SizedBox(
                  height: GremionTokens.touchTargetMin + 8,
                  child: ElevatedButton.icon(
                    onPressed: _loading ? null : _login,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: GremionTokens.accentDark,
                      foregroundColor: GremionTokens.paperDark,
                      elevation: 0,
                      shape: const RoundedRectangleBorder(
                        borderRadius: GremionTokens.rMd,
                      ),
                      textStyle: const TextStyle(
                        fontFamily: GremionTokens.fontBody,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    icon: _loading
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: GremionTokens.paperDark,
                            ),
                          )
                        : const Icon(Icons.login_outlined, size: 18),
                    label:
                        Text(_loading ? 'Anmeldung…' : 'Mit Keycloak anmelden'),
                  ),
                ),
                const SizedBox(height: GremionTokens.s5),
                // Single identity provider (Keycloak SSO) — no infrastructure
                // language surfaced; mirrors the web single-provider login.
                const Text(
                  'STURAOS · HS HARZ',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontFamily: GremionTokens.fontMono,
                    fontSize: 10,
                    letterSpacing: 1.5,
                    color: GremionTokens.inkFaintDark,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
