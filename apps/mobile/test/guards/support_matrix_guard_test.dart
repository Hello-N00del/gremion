// TASK-166 guard 4: the declared support matrix (TRD-290: Android 10+,
// iOS 16+) is what the build files say, read statically. targetSdk is
// TASK-179's and deliberately not checked here.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Android: literal minSdk = 29 (Android 10)', () {
    final gradle = File('android/app/build.gradle.kts').readAsStringSync();
    final minSdk = RegExp(r'^\s*minSdk\s*=\s*(.+?)\s*$', multiLine: true)
        .allMatches(gradle)
        .map((m) => m[1])
        .toList();
    expect(minSdk, ['29'],
        reason: 'expected exactly one `minSdk = 29`, found $minSdk');
  });

  group('iOS: deployment target 16.0', () {
    test('every build configuration in project.pbxproj', () {
      final pbxproj =
          File('ios/Runner.xcodeproj/project.pbxproj').readAsStringSync();
      final configs = RegExp(
        r'^\t\t\w+ /\* (\w+) \*/ = \{\n\t\t\tisa = XCBuildConfiguration;\n'
        r'([\s\S]*?)\n\t\t\};',
        multiLine: true,
      ).allMatches(pbxproj).toList();
      // Project + Runner + RunnerTests, each Debug/Release/Profile.
      expect(configs.length, greaterThanOrEqualTo(9),
          reason: 'XCBuildConfiguration blocks were not parsed');

      final wrong = <String>[];
      for (final config in configs) {
        final targets = RegExp(r'IPHONEOS_DEPLOYMENT_TARGET = ([^;]+);')
            .allMatches(config[2]!)
            .map((m) => m[1])
            .toList();
        if (targets.length != 1 || targets.single != '16.0') {
          wrong.add('${config[1]}: $targets');
        }
      }
      expect(wrong, isEmpty,
          reason: 'build configurations not at IPHONEOS_DEPLOYMENT_TARGET '
              '16.0:\n${wrong.join('\n')}');
    });

    test("Podfile: platform :ios, '16.0'", () {
      final podfile = File('ios/Podfile').readAsStringSync();
      final platforms = RegExp(r'^\s*platform\s+:ios\s*,\s*(.+?)\s*$',
              multiLine: true)
          .allMatches(podfile)
          .map((m) => m[1])
          .toList();
      expect(platforms, ["'16.0'"]);
    });
  });
}
