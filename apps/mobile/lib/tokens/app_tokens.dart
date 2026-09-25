// mobile/lib/tokens/app_tokens.dart
//
// Legacy token facade — now THEME-AWARE.
//
// Originally (PR 6) this facade re-pointed onto the 2026-05-28 design-refresh
// tokens (GremionTokens), but it hard-coded the *Dark variants, which locked
// every consumer screen to dark and broke light mode (e.g. near-white ink on
// the light `paper` scaffold). The MaterialApp already ships both light + dark
// `ThemeData` (theme/app_theme.dart) under `ThemeMode.system`, so the facade is
// the only thing that wasn't following the active brightness.
//
// `AppColors` and `AppTextStyles` now resolve light/dark from the active
// `BuildContext` via `AppColors.of(context)` / `AppTextStyles.of(context)`.
// `AppSpacing` and `AppRadius` are brightness-independent numeric scales and
// keep their static-const API unchanged.
//
// New code should still prefer GremionTokens / Theme.of(context) directly (see
// screens/home/home_screen.dart for the canonical pattern); this facade is
// retained so the pre-refresh screens stay buildable and now render correctly
// in both modes.
// ignore_for_file: prefer_single_quotes

import 'package:flutter/material.dart';

import 'design_tokens.dart';

/// Colour tokens, resolved for the active theme brightness.
///
/// Obtain a resolved instance with `AppColors.of(context)`. Neutrals (bg /
/// surface / border / text / textMuted) and accents map to the GremionTokens
/// light or dark variant depending on `Theme.of(context).brightness`.
@immutable
class AppColors {
  const AppColors._({
    required this.bg,
    required this.surface,
    required this.border,
    required this.text,
    required this.textMuted,
    required this.primary,
    required this.danger,
    required this.success,
    required this.warning,
    required this.msgMine,
    required this.msgOther,
  });

  final Color bg;
  final Color surface;
  final Color border;
  final Color text;
  final Color textMuted;
  final Color primary;
  final Color danger;
  final Color success;
  final Color warning;

  // Chat-specific — own messages use the accent-soft surface, others the card.
  final Color msgMine;
  final Color msgOther;

  /// E2E indicator shares the success accent.
  Color get e2eIcon => success;

  static const AppColors _light = AppColors._(
    bg: GremionTokens.paper,
    surface: GremionTokens.surface,
    border: GremionTokens.border,
    text: GremionTokens.ink,
    textMuted: GremionTokens.inkMuted,
    primary: GremionTokens.accent,
    danger: GremionTokens.rust,
    success: GremionTokens.pine,
    warning: GremionTokens.ember,
    msgMine: GremionTokens.accentSoft,
    msgOther: GremionTokens.surface,
  );

  static const AppColors _dark = AppColors._(
    bg: GremionTokens.paperDark,
    surface: GremionTokens.surfaceDark,
    border: GremionTokens.borderDark,
    text: GremionTokens.inkDark,
    textMuted: GremionTokens.inkMutedDark,
    primary: GremionTokens.accentDark,
    danger: GremionTokens.rustDark,
    success: GremionTokens.pineDark,
    warning: GremionTokens.emberDark,
    msgMine: GremionTokens.accentSoftDark,
    msgOther: GremionTokens.surfaceDark,
  );

  /// Resolve the colour set for the active theme brightness.
  static AppColors of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? _dark : _light;
}

/// Border radius tokens — mapped to the GremionTokens radii scale.
/// Brightness-independent, so kept as a static-const facade.
abstract final class AppRadius {
  static const double sm = 6.0; // GremionTokens.rSm
  static const double md = 10.0; // GremionTokens.rMd
  static const double lg = 14.0; // GremionTokens.rLg
}

/// Spacing tokens — mapped to the GremionTokens 4-step scale.
/// Brightness-independent, so kept as a static-const facade.
abstract final class AppSpacing {
  static const double xs = GremionTokens.s1; // 4
  static const double sm = GremionTokens.s2; // 8
  static const double md = GremionTokens.s4; // 16
  static const double lg = GremionTokens.s6; // 24
  static const double xl = GremionTokens.s7; // 32
  static const double xxl = GremionTokens.s8; // 48
}

/// Typography tokens, resolved for the active theme brightness.
///
/// Obtain a resolved instance with `AppTextStyles.of(context)`. Font families
/// and sizes are fixed; only the ink colour flips between light and dark.
@immutable
class AppTextStyles {
  const AppTextStyles._(this._ink, this._inkMuted);

  final Color _ink;
  final Color _inkMuted;

  static const String fontFamily = GremionTokens.fontBody;

  TextStyle get headingLg => TextStyle(
        fontFamily: GremionTokens.fontDisplay,
        fontSize: 26.0,
        fontWeight: FontWeight.w500,
        color: _ink,
      );

  TextStyle get headingMd => TextStyle(
        fontFamily: GremionTokens.fontDisplay,
        fontSize: 17.0,
        fontWeight: FontWeight.w600,
        color: _ink,
      );

  TextStyle get body => TextStyle(
        fontFamily: GremionTokens.fontBody,
        fontSize: 15.0,
        fontWeight: FontWeight.w400,
        color: _ink,
        height: 1.5,
      );

  TextStyle get bodyMuted => TextStyle(
        fontFamily: GremionTokens.fontBody,
        fontSize: 15.0,
        fontWeight: FontWeight.w400,
        color: _inkMuted,
        height: 1.5,
      );

  TextStyle get caption => TextStyle(
        fontFamily: GremionTokens.fontBody,
        fontSize: 12.5,
        fontWeight: FontWeight.w400,
        color: _inkMuted,
      );

  TextStyle get label => TextStyle(
        fontFamily: GremionTokens.fontBody,
        fontSize: 13.5,
        fontWeight: FontWeight.w500,
        color: _ink,
      );

  /// Resolve the text styles for the active theme brightness.
  static AppTextStyles of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark
          ? const AppTextStyles._(GremionTokens.inkDark, GremionTokens.inkMutedDark)
          : const AppTextStyles._(GremionTokens.ink, GremionTokens.inkMuted);
}
