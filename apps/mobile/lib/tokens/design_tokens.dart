// StuRaOS design tokens (2026-05-28 refresh, PR 0a) — mirrors gremion-ui/src/app.css.
//
// oklch accents converted to sRGB hex via the Björn Ottosson OKLab matrices with
// per-channel gamut clamp (~70% perceptual fidelity vs the oklch source; a few
// ink/soft variants clamp slightly out-of-sRGB-gamut). Source of truth:
// docs/design/2026-05-28-tokens.md §11. Neutrals are direct sRGB hex from the doc.
import 'package:flutter/material.dart';

class GremionTokens {
  GremionTokens._();

  // Display face = Archivo Narrow (bundled in pubspec.yaml, slice 9). Matches
  // the web slice-1 --font-display fix; "Outfit" was never loaded anywhere.
  static const String fontDisplay = 'Archivo Narrow';
  static const String fontBody = 'Inter';
  static const String fontMono = 'JetBrains Mono';

  // Neutrals — light
  static const Color paper = Color(0xFFFAFAF7);
  static const Color surface = Color(0xFFFFFFFF);
  static const Color surface2 = Color(0xFFF4F3EE);
  static const Color surface3 = Color(0xFFEBE9E1);
  static const Color ink = Color(0xFF161513);
  static const Color ink2 = Color(0xFF3A3831);
  static const Color inkMuted = Color(0xFF6B685F);
  static const Color inkFaint = Color(0xFF9A968B);
  static const Color border = Color(0x17161513);
  static const Color borderStrong = Color(0x29161513);

  // Neutrals — dark
  static const Color paperDark = Color(0xFF0E0F10);
  static const Color surfaceDark = Color(0xFF161719);
  static const Color surface2Dark = Color(0xFF1D1E21);
  static const Color surface3Dark = Color(0xFF25262A);
  static const Color inkDark = Color(0xFFEDECE7);
  static const Color ink2Dark = Color(0xFFC4C2BA);
  static const Color inkMutedDark = Color(0xFF8C8A82);
  static const Color inkFaintDark = Color(0xFF5E5C55);
  static const Color borderDark = Color(0x14EDECE7);
  static const Color borderStrongDark = Color(0x29EDECE7);

  // Accents — light (oklch -> sRGB)
  static const Color accent = Color(0xFF154E87);
  static const Color accentInk = Color(0xFF003D74);
  static const Color accentSoft = Color(0xFFD8EAFF);
  static const Color accentFaint = Color(0xFFE8F3FF);
  static const Color ember = Color(0xFFB05A00);
  static const Color emberSoft = Color(0xFFFFE3CC);
  static const Color emberInk = Color(0xFF7C2A00); // §16 finding 1
  static const Color pine = Color(0xFF00704E);
  static const Color pineSoft = Color(0xFFD4F4E5);
  static const Color pineInk = Color(0xFF004E2E);
  static const Color rust = Color(0xFFAF3E32);
  static const Color rustSoft = Color(0xFFFFDFD8);
  static const Color rustInk = Color(0xFF800805);

  // Accents — dark (oklch -> sRGB)
  static const Color accentDark = Color(0xFF64A9F3);
  static const Color accentInkDark = Color(0xFF82BCFC);
  static const Color accentSoftDark = Color(0xFF102A45);
  static const Color accentFaintDark = Color(0xFF0C1B2D);
  static const Color emberDark = Color(0xFFED914A);
  static const Color emberSoftDark = Color(0xFF421E00);
  static const Color emberInkDark = Color(0xFFF6B384);
  static const Color pineDark = Color(0xFF46B68C);
  static const Color pineSoftDark = Color(0xFF002D1D);
  static const Color pineInkDark = Color(0xFF82D9B4);
  static const Color rustDark = Color(0xFFE8796B);
  static const Color rustSoftDark = Color(0xFF491510);
  static const Color rustInkDark = Color(0xFFFEAC9F);

  // Radii
  static const BorderRadius rXs = BorderRadius.all(Radius.circular(3));
  static const BorderRadius rSm = BorderRadius.all(Radius.circular(6));
  static const BorderRadius rMd = BorderRadius.all(Radius.circular(10));
  static const BorderRadius rLg = BorderRadius.all(Radius.circular(14));

  // Spacing
  static const double s1 = 4;
  static const double s2 = 8;
  static const double s3 = 12;
  static const double s4 = 16;
  static const double s5 = 20;
  static const double s6 = 24;
  static const double s7 = 32;
  static const double s8 = 48;

  // Motion
  static const Curve curveOut = Cubic(0.2, 0.8, 0.2, 1.0);
  static const Duration durationFast = Duration(milliseconds: 120);
  static const Duration durationMed = Duration(milliseconds: 220);

  // §16 finding 3 — touch target floor
  static const double touchTargetMin = 44.0;
}
