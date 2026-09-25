import 'package:flutter/material.dart';
import 'package:stura/tokens/design_tokens.dart';

// PR 0a T0a.15 — text theme consuming the bundle token namespace.
// Font families (Archivo Narrow/Inter/JetBrains Mono — the slice-1 display fix;
// "Outfit" was never loaded) are referenced by name via GremionTokens; the font
// binaries + pubspec `fonts:` block are bundled in PR 6 (mobile literal port),
// where this theme is wired into MaterialApp.
class GremionTextTheme {
  GremionTextTheme._();

  static TextTheme light() => const TextTheme(
        displayLarge: TextStyle(
            fontFamily: GremionTokens.fontDisplay,
            fontSize: 56,
            fontWeight: FontWeight.w500,
            color: GremionTokens.ink,
            letterSpacing: -1.1),
        displayMedium: TextStyle(
            fontFamily: GremionTokens.fontDisplay,
            fontSize: 34,
            fontWeight: FontWeight.w500,
            color: GremionTokens.ink,
            letterSpacing: -0.5),
        headlineLarge: TextStyle(
            fontFamily: GremionTokens.fontDisplay,
            fontSize: 26,
            fontWeight: FontWeight.w500,
            color: GremionTokens.ink),
        titleLarge: TextStyle(
            fontFamily: GremionTokens.fontDisplay,
            fontSize: 17,
            fontWeight: FontWeight.w600,
            color: GremionTokens.ink),
        bodyLarge: TextStyle(
            fontFamily: GremionTokens.fontBody,
            fontSize: 16,
            fontWeight: FontWeight.w400,
            color: GremionTokens.ink,
            height: 1.5),
        bodyMedium: TextStyle(
            fontFamily: GremionTokens.fontBody,
            fontSize: 14,
            fontWeight: FontWeight.w400,
            color: GremionTokens.ink,
            height: 1.5),
        bodySmall: TextStyle(
            fontFamily: GremionTokens.fontBody,
            fontSize: 12.5,
            fontWeight: FontWeight.w400,
            color: GremionTokens.inkMuted,
            height: 1.5),
        labelLarge: TextStyle(
            fontFamily: GremionTokens.fontBody,
            fontSize: 13.5,
            fontWeight: FontWeight.w500,
            color: GremionTokens.ink),
        labelSmall: TextStyle(
            fontFamily: GremionTokens.fontMono,
            fontSize: 10.5,
            fontWeight: FontWeight.w500,
            color: GremionTokens.inkMuted,
            letterSpacing: 1.5),
      );
}
