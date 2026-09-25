// mobile/lib/tokens/committee_hue.dart
//
// Phase 5 (v5 mobile rebuild) — shared presentation helpers reused by the
// rebuilt screens (calendar agenda, chat list, …).
//
//  * [committeeHue] derives a *stable* OKLCH-ish hue (0–360) from an arbitrary
//    committee / org-unit key, so each committee gets its own consistent colour
//    without any per-event hue field on the data model (the live
//    `CalendarEvent` carries no org-unit). Mirrors the web prototype's
//    `--c-hue` / `oklch(... hue)` committee colouring (mobile.css:324).
//  * [committeeColor] converts that hue into an sRGB [Color] at the same
//    lightness / chroma the prototype uses for the agenda gutter bar
//    (`oklch(50% 0.13 hue)` light · `oklch(72% 0.14 hue)` dark).
//  * [MScreenHead] is the v5 page header (mono eyebrow + display title + muted
//    sub) shared by every rebuilt screen — matches `.m-head` in mobile.css.
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'design_tokens.dart';

/// Stable hue in [0, 360) derived from [key] (a committee / org-unit name or
/// any grouping string). Empty / null keys fall back to the prototype default
/// hue (252, the blue-violet used when an event has no committee).
int committeeHue(String? key) {
  final k = (key ?? '').trim().toLowerCase();
  if (k.isEmpty) return 252;
  // FNV-1a-ish hash → spread across the wheel. Deterministic per string.
  var hash = 2166136261;
  for (final unit in k.codeUnits) {
    hash ^= unit;
    hash = (hash * 16777619) & 0xFFFFFFFF;
  }
  return hash % 360;
}

/// A short uppercase monogram (≤2 chars) for the committee gutter, derived from
/// [key]. "Finanzen & Haushalt" → "FH", "Plenum" → "PL".
String committeeMonogram(String? key) {
  final words = (key ?? '')
      .trim()
      .split(RegExp(r'[\s\-/&]+'))
      .where((w) => w.isNotEmpty)
      .toList();
  if (words.isEmpty) return '··';
  if (words.length == 1) {
    final w = words.first;
    return (w.length >= 2 ? w.substring(0, 2) : w).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/// Convert an OKLCH (L, C, H) triple to an sRGB [Color]. L in [0,1], C the
/// chroma, H in degrees. Uses the Björn Ottosson OKLab→linear-sRGB matrices
/// with a per-channel gamut clamp — the same conversion documented for the
/// static GremionTokens accents.
Color _oklch(double l, double c, double hDeg) {
  final h = hDeg * math.pi / 180.0;
  final aa = c * math.cos(h);
  final bb = c * math.sin(h);

  final lDash = l + 0.3963377774 * aa + 0.2158037573 * bb;
  final mDash = l - 0.1055613458 * aa - 0.0638541728 * bb;
  final sDash = l - 0.0894841775 * aa - 1.2914855480 * bb;

  final lc = lDash * lDash * lDash;
  final mc = mDash * mDash * mDash;
  final sc = sDash * sDash * sDash;

  final r = 4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc;
  final g = -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc;
  final b = -0.0041960863 * lc - 0.7034186147 * mc + 1.7076147010 * sc;

  int toByte(double linear) {
    final v = linear <= 0.0031308
        ? 12.92 * linear
        : 1.055 * math.pow(linear, 1 / 2.4) - 0.055;
    return (v.clamp(0.0, 1.0) * 255).round();
  }

  return Color.fromARGB(255, toByte(r), toByte(g), toByte(b));
}

/// Committee gutter bar colour for [key] at the prototype's lightness/chroma,
/// brightness-aware (light: `oklch(50% 0.13 h)`, dark: `oklch(72% 0.14 h)`).
Color committeeColor(String? key, {required bool dark}) {
  final h = committeeHue(key).toDouble();
  return dark ? _oklch(0.72, 0.14, h) : _oklch(0.50, 0.13, h);
}

/// The shared v5 page header (`.m-head`): mono eyebrow, display-font title,
/// muted subtitle, on a [GremionTokens.surface] band with a hairline bottom
/// border. [trailing] optionally sits at the title's trailing edge (e.g. an
/// action button).
class MScreenHead extends StatelessWidget {
  const MScreenHead({
    required this.eyebrow,
    required this.title,
    this.sub,
    this.subMono = false,
    this.trailing,
    super.key,
  });

  final String eyebrow;
  final String title;
  final String? sub;
  final bool subMono;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final muted = dark ? GremionTokens.inkMutedDark : GremionTokens.inkMuted;
    final onSurface = Theme.of(context).colorScheme.onSurface;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(
          GremionTokens.s5, GremionTokens.s4, GremionTokens.s5, GremionTokens.s3),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border:
            Border(bottom: BorderSide(color: Theme.of(context).dividerColor)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            eyebrow.toUpperCase(),
            style: TextStyle(
              fontFamily: GremionTokens.fontMono,
              fontSize: 10,
              letterSpacing: 1.6,
              fontWeight: FontWeight.w500,
              color: muted,
            ),
          ),
          const SizedBox(height: 4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              Expanded(
                child: Text(
                  title,
                  style: TextStyle(
                    fontFamily: GremionTokens.fontDisplay,
                    fontSize: 28,
                    fontWeight: FontWeight.w500,
                    height: 1.1,
                    letterSpacing: -0.4,
                    color: onSurface,
                  ),
                ),
              ),
              if (trailing != null) trailing!,
            ],
          ),
          if (sub != null && sub!.isNotEmpty) ...[
            const SizedBox(height: 3),
            Text(
              sub!,
              style: TextStyle(
                fontFamily:
                    subMono ? GremionTokens.fontMono : GremionTokens.fontBody,
                fontSize: subMono ? 11 : 12.5,
                letterSpacing: subMono ? 0.4 : 0,
                color: muted,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
