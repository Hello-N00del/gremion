// mobile/lib/brand.dart
//
// Central tenant-branding constants for the Flutter app — the single source
// for institution-specific UI strings, mirroring `gremion-ui/src/lib/brand.ts`
// (`product, logoLetter, orgShort, term, orgName, domain, matrixHomeserver`).
//
// Values are hydrated from compile-time `--dart-define`s (the same mechanism
// `app.dart` already uses for `HOMESERVER_URL` / `GATEWAY_URL`), defaulting to
// the canonical HS-Harz values so the UI never renders a blank brand.
//
// Components MUST read these instead of inlining "StuRaOS"/"HS Harz"/the domain.
class Brand {
  Brand._();

  static const String product = String.fromEnvironment(
    'BRAND_PRODUCT',
    defaultValue: 'StuRaOS',
  );

  static const String logoLetter = String.fromEnvironment(
    'BRAND_LOGO_LETTER',
    defaultValue: 'S',
  );

  static const String orgShort = String.fromEnvironment(
    'BRAND_ORG_SHORT',
    defaultValue: 'HS Harz',
  );

  static const String term = String.fromEnvironment(
    'BRAND_TERM',
    defaultValue: 'SoSe 26',
  );

  static const String orgName = String.fromEnvironment(
    'BRAND_ORG_NAME',
    defaultValue: 'Studierendenrat der Hochschule Harz',
  );

  static const String domain = String.fromEnvironment(
    'BRAND_DOMAIN',
    defaultValue: 'stura.hs-harz.de',
  );

  static const String matrixHomeserver = String.fromEnvironment(
    'BRAND_MATRIX_HOMESERVER',
    defaultValue: 'stura.hs-harz.de',
  );
}
