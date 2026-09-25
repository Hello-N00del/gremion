// mobile/lib/theme/app_theme.dart
//
// PR 6 T6.1 — MaterialApp themes built from the 2026-05-28 design-refresh
// tokens (GremionTokens) + GremionTextTheme. Light is the canonical surface; dark
// is reached via ThemeMode.system using the *Dark token variants.
//
// NOTE: ColorScheme.background / onBackground are deprecated in the current
// Flutter SDK (the analyzer gate requires 0 issues), so the scaffold background
// is expressed via scaffoldBackgroundColor instead of the deprecated members
// from the plan snippet.
import 'package:flutter/material.dart';
import 'package:stura/theme/text_theme.dart';
import 'package:stura/tokens/design_tokens.dart';

ThemeData lightTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.light,
    colorScheme: const ColorScheme.light(
      primary: GremionTokens.accent,
      onPrimary: GremionTokens.paper,
      secondary: GremionTokens.ember,
      onSecondary: GremionTokens.paper,
      surface: GremionTokens.surface,
      onSurface: GremionTokens.ink,
      error: GremionTokens.rust,
      onError: GremionTokens.rustSoft,
      outline: GremionTokens.borderStrong,
    ),
    scaffoldBackgroundColor: GremionTokens.paper,
    fontFamily: GremionTokens.fontBody,
    textTheme: GremionTextTheme.light(),
  );
  return _applyComponents(
    base,
    surface: GremionTokens.surface,
    surfaceAlt: GremionTokens.surface2,
    border: GremionTokens.border,
    onSurface: GremionTokens.ink,
    muted: GremionTokens.inkMuted,
    primary: GremionTokens.accent,
    onPrimary: GremionTokens.paper,
  );
}

ThemeData darkTheme() {
  final base = ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    colorScheme: const ColorScheme.dark(
      primary: GremionTokens.accentDark,
      onPrimary: GremionTokens.paperDark,
      secondary: GremionTokens.emberDark,
      onSecondary: GremionTokens.paperDark,
      surface: GremionTokens.surfaceDark,
      onSurface: GremionTokens.inkDark,
      error: GremionTokens.rustDark,
      outline: GremionTokens.borderStrongDark,
    ),
    scaffoldBackgroundColor: GremionTokens.paperDark,
    fontFamily: GremionTokens.fontBody,
    textTheme: GremionTextTheme.light().apply(
      bodyColor: GremionTokens.inkDark,
      displayColor: GremionTokens.inkDark,
    ),
  );
  return _applyComponents(
    base,
    surface: GremionTokens.surfaceDark,
    surfaceAlt: GremionTokens.surface2Dark,
    border: GremionTokens.borderDark,
    onSurface: GremionTokens.inkDark,
    muted: GremionTokens.inkMutedDark,
    primary: GremionTokens.accentDark,
    onPrimary: GremionTokens.paperDark,
  );
}

/// Shared component theming applied identically to both brightnesses with the
/// per-mode token set threaded in. Keeps light/dark visually faithful to the
/// bundle (rMd radii, token borders, 44pt min touch targets).
ThemeData _applyComponents(
  ThemeData base, {
  required Color surface,
  required Color surfaceAlt,
  required Color border,
  required Color onSurface,
  required Color muted,
  required Color primary,
  required Color onPrimary,
}) {
  return base.copyWith(
    appBarTheme: AppBarTheme(
      backgroundColor: base.scaffoldBackgroundColor,
      foregroundColor: onSurface,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: base.textTheme.titleLarge,
    ),
    cardTheme: CardThemeData(
      color: surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: GremionTokens.rMd,
        side: BorderSide(color: border),
      ),
    ),
    dividerTheme: DividerThemeData(color: border, thickness: 1, space: 1),
    listTileTheme: ListTileThemeData(
      iconColor: muted,
      textColor: onSurface,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: surfaceAlt,
      contentPadding: const EdgeInsets.symmetric(
        horizontal: GremionTokens.s4,
        vertical: GremionTokens.s3,
      ),
      border: OutlineInputBorder(
        borderRadius: GremionTokens.rMd,
        borderSide: BorderSide(color: border),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: GremionTokens.rMd,
        borderSide: BorderSide(color: border),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: GremionTokens.rMd,
        borderSide: BorderSide(color: primary, width: 2),
      ),
      labelStyle: base.textTheme.bodyMedium?.copyWith(color: muted),
      hintStyle: base.textTheme.bodyMedium?.copyWith(color: muted),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: primary,
        foregroundColor: onPrimary,
        elevation: 0,
        minimumSize: const Size(0, GremionTokens.touchTargetMin),
        padding: const EdgeInsets.symmetric(
          horizontal: GremionTokens.s5,
          vertical: GremionTokens.s3,
        ),
        shape: const RoundedRectangleBorder(borderRadius: GremionTokens.rMd),
        textStyle: base.textTheme.labelLarge,
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: primary,
        textStyle: base.textTheme.labelLarge,
      ),
    ),
    chipTheme: base.chipTheme.copyWith(
      backgroundColor: surfaceAlt,
      side: BorderSide(color: border),
      shape: const RoundedRectangleBorder(borderRadius: GremionTokens.rSm),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: surface,
      indicatorColor: primary.withValues(alpha: 0.16),
      elevation: 0,
      labelTextStyle: WidgetStatePropertyAll(base.textTheme.labelSmall),
    ),
  );
}
