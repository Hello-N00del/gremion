import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:stura/tokens/design_tokens.dart';

void main() {
  group('GremionTokens — neutrals', () {
    test('paper is #FAFAF7 in light mode', () {
      expect(GremionTokens.paper.toARGB32(), equals(0xFFFAFAF7));
    });
    test('paperDark is #0E0F10', () {
      expect(GremionTokens.paperDark.toARGB32(), equals(0xFF0E0F10));
    });
    test('ink is #161513', () {
      expect(GremionTokens.ink.toARGB32(), equals(0xFF161513));
    });
  });

  group('GremionTokens — accents have ink-variants for AA-pill-text', () {
    test('emberInk is darker than ember', () {
      expect(HSLColor.fromColor(GremionTokens.emberInk).lightness,
          lessThan(HSLColor.fromColor(GremionTokens.ember).lightness));
    });
    test('rustInk is darker than rust', () {
      expect(HSLColor.fromColor(GremionTokens.rustInk).lightness,
          lessThan(HSLColor.fromColor(GremionTokens.rust).lightness));
    });
    test('pineInk is darker than pine', () {
      expect(HSLColor.fromColor(GremionTokens.pineInk).lightness,
          lessThan(HSLColor.fromColor(GremionTokens.pine).lightness));
    });
  });

  group('GremionTokens — touch target', () {
    test('touchTargetMin is at least 44.0', () {
      expect(GremionTokens.touchTargetMin, greaterThanOrEqualTo(44.0));
    });
  });

  group('GremionTokens — spacing scale is 4-step', () {
    test('s1..s8 follow the 4/8/12/16/20/24/32/48 progression', () {
      expect([
        GremionTokens.s1,
        GremionTokens.s2,
        GremionTokens.s3,
        GremionTokens.s4,
        GremionTokens.s5,
        GremionTokens.s6,
        GremionTokens.s7,
        GremionTokens.s8,
      ], equals([4.0, 8.0, 12.0, 16.0, 20.0, 24.0, 32.0, 48.0]));
    });
  });
}
