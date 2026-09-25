// TASK-166 guard 2: the app resolves Matrix Dart SDK 13.x (Q4: 13.0.0 or a
// newer 13.x.y, never 14.x). The lockfile is what ships, so it decides.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The `version:` of [package] in pubspec.lock, or null if it is not locked.
String? lockedVersion(String lock, String package) {
  final block = RegExp(
    '^  ${RegExp.escape(package)}:\\n((?:    .*\\n)+)',
    multiLine: true,
  ).firstMatch(lock);
  if (block == null) return null;
  return RegExp(r'^    version: "([^"]+)"$', multiLine: true)
      .firstMatch(block[1]!)?[1];
}

void main() {
  // CRLF-safe: the operator's Windows checkout uses core.autocrlf=true.
  final lock =
      File('pubspec.lock').readAsStringSync().replaceAll('\r\n', '\n');

  test('pubspec.lock resolves matrix to a 13.x.y release', () {
    final version = lockedVersion(lock, 'matrix');
    expect(version, isNotNull, reason: 'matrix is not in pubspec.lock');
    expect(version, matches(RegExp(r'^13\.\d+\.\d+$')),
        reason: 'expected Matrix Dart SDK 13.x.y, got $version');
  });

  test('pubspec.yaml keeps matrix inside the 13 major', () {
    final pubspec =
        File('pubspec.yaml').readAsStringSync().replaceAll('\r\n', '\n');
    final constraint = RegExp(r'^  matrix:\s*(\S+)', multiLine: true)
        .firstMatch(pubspec)?[1];
    expect(constraint, isNotNull, reason: 'matrix is not a direct dependency');
    // An exact 13.x.y pin, or a caret range that cannot reach 14.
    expect(constraint, matches(RegExp(r'^\^?13\.\d+\.\d+$')));
  });
}
