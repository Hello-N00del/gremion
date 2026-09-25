// TASK-166 guard 1: no Firebase Cloud Messaging (FCM) anywhere in the app.
//
// Acceptance: no FCM dependency remains in the dependency graph, verified by
// a dependency-tree grep that finds zero references to the FCM plugin.
// Two independent sources are checked:
//   1. the source tree git knows about (tracked files plus untracked files
//      that are not ignored), so generated, gitignored files such as
//      ios/Runner/GeneratedPluginRegistrant.m or .flutter-plugins-dependencies
//      can neither fail nor pass this guard;
//   2. the resolved dependency graph, from `flutter pub deps --style=list`
//      and from pubspec.lock.
//
// The patterns are assembled from fragments so this file does not match
// itself.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

final _forbidden = RegExp(
  [
    'firebase' '_messaging',
    'firebase' '_core',
    r'com\.google\.' 'firebase',
    'Firebase' 'Messaging',
  ].join('|'),
);

final _firebasePackage = RegExp(r'^firebase_\w+$');

Future<ProcessResult> _run(String executable, List<String> args) =>
    Process.run(
      executable,
      args,
      runInShell: Platform.isWindows,
      stdoutEncoding: utf8,
      stderrEncoding: utf8,
    );

String _flutterExecutable() {
  final root = Platform.environment['FLUTTER_ROOT'];
  final name = Platform.isWindows ? 'flutter.bat' : 'flutter';
  if (root == null || root.isEmpty) return name;
  return [root, 'bin', name].join(Platform.pathSeparator);
}

void main() {
  test('no tracked or unignored source file references FCM', () async {
    final result = await _run('git', [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ]);
    expect(result.exitCode, 0, reason: 'git ls-files failed: ${result.stderr}');
    final files = (result.stdout as String)
        .split('\x00')
        .where((f) => f.isNotEmpty)
        .toList();
    // A guard that scans nothing proves nothing.
    expect(files, contains('pubspec.yaml'),
        reason: 'git ls-files must list the app root (cwd ${Directory.current.path})');

    final offenders = <String>[];
    for (final path in files) {
      final file = File(path);
      if (!file.existsSync()) continue; // deleted in the worktree
      final text = latin1.decode(file.readAsBytesSync());
      final lines = const LineSplitter().convert(text);
      for (var i = 0; i < lines.length; i++) {
        final match = _forbidden.firstMatch(lines[i]);
        if (match != null) offenders.add('$path:${i + 1}: ${match[0]}');
      }
    }
    expect(offenders, isEmpty,
        reason: 'FCM references in the source tree:\n${offenders.join('\n')}');
  });

  test('no firebase_* package in the resolved dependency graph', () async {
    final result =
        await _run(_flutterExecutable(), ['pub', 'deps', '--style=list']);
    expect(result.exitCode, 0,
        reason: 'flutter pub deps failed: ${result.stderr}');
    final out = result.stdout as String;
    // Every package appears as "- name version" at some indent.
    final packages = RegExp(r'^\s*- (\S+) ', multiLine: true)
        .allMatches(out)
        .map((m) => m[1]!)
        .toSet();
    expect(packages, contains('flutter'),
        reason: 'pub deps output was not parsed:\n$out');
    expect(packages.where(_firebasePackage.hasMatch), isEmpty);
  });

  test('pubspec.lock resolves no firebase_* package', () {
    final lock = File('pubspec.lock').readAsStringSync();
    final names = RegExp(r'^  (\w+):$', multiLine: true)
        .allMatches(lock)
        .map((m) => m[1]!)
        .toSet();
    expect(names, contains('flutter_test'),
        reason: 'pubspec.lock was not parsed');
    expect(names.where(_firebasePackage.hasMatch), isEmpty);
  });
}
