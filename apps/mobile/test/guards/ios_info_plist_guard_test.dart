// TASK-166: the iOS scaffold keeps what the harvested Info.plist carried,
// and a regenerated plist cannot silently drop it:
// - the AppAuth redirect scheme (stura://auth/callback) and the Face ID
//   usage string (local_auth);
// - no FCM-era background modes (TRD-293: no push transport on iOS yet);
// - the G-046 ATS split: Release/Profile use Info.plist with no ATS
//   exception, Debug uses Info-Debug.plist (selected by Debug.xcconfig) which
//   differs only by NSAppTransportSecurity { NSAllowsLocalNetworking };
// - the UIScene manifest the Flutter 3.41 AppDelegate relies on to register
//   plugins.
// Static reads only: nothing here needs macOS.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// CRLF-safe read: the operator's Windows checkout uses core.autocrlf=true.
String _read(String path) =>
    File(path).readAsStringSync().replaceAll('\r\n', '\n');

String _withoutComments(String xml) =>
    xml.replaceAll(RegExp(r'<!--[\s\S]*?-->'), '');

String _normalized(String xml) =>
    _withoutComments(xml).replaceAll(RegExp(r'\s+'), '');

final _ats = RegExp(
  r'<key>NSAppTransportSecurity</key>\s*<dict>\s*'
  r'<key>NSAllowsLocalNetworking</key>\s*<true/>\s*</dict>',
);

/// The body of the XCBuildConfiguration named [name] (e.g. `Debug`) whose
/// block contains [marker].
String _buildConfiguration(String pbxproj, String name, String marker) {
  final blocks = RegExp(
    r'^\t\t\w+ /\* ' '$name' r' \*/ = \{\n\t\t\tisa = XCBuildConfiguration;\n'
    r'[\s\S]*?\n\t\t\};',
    multiLine: true,
  ).allMatches(pbxproj).map((m) => m[0]!).where((b) => b.contains(marker));
  expect(blocks, hasLength(1),
      reason: 'expected one $name configuration containing $marker');
  return blocks.single;
}

void main() {
  final release = _read('ios/Runner/Info.plist');
  final debug = _read('ios/Runner/Info-Debug.plist');

  for (final (name, plist) in [
    ('Info.plist', release),
    ('Info-Debug.plist', debug),
  ]) {
    group(name, () {
      final xml = _withoutComments(plist);

      test('registers the stura URL scheme (AppAuth redirect)', () {
        expect(
          xml,
          matches(RegExp(r'<key>CFBundleURLSchemes</key>\s*<array>\s*'
              r'<string>stura</string>\s*</array>')),
        );
      });

      test('keeps the Face ID usage description', () {
        expect(
          xml,
          matches(RegExp(
              r'<key>NSFaceIDUsageDescription</key>\s*<string>[^<]+</string>')),
        );
      });

      test('declares no background modes (no push transport on iOS)', () {
        expect(xml, isNot(contains('UIBackgroundModes')));
        expect(xml, isNot(contains('remote-notification')));
      });

      test('declares the UIScene manifest with SceneDelegate', () {
        expect(xml, contains('<key>UIApplicationSceneManifest</key>'));
        expect(xml, contains(r'$(PRODUCT_MODULE_NAME).SceneDelegate'));
      });
    });
  }

  test('Info.plist (Release/Profile) has no ATS exception', () {
    expect(_withoutComments(release),
        isNot(contains('NSAppTransportSecurity')));
  });

  test('Info-Debug.plist is Info.plist plus NSAllowsLocalNetworking only', () {
    final debugXml = _withoutComments(debug);
    expect(_ats.allMatches(debugXml), hasLength(1));
    expect(_normalized(debugXml.replaceFirst(_ats, '')), _normalized(release));
  });

  test('Debug selects Info-Debug.plist; Release/Profile select Info.plist',
      () {
    expect(_read('ios/Flutter/Debug.xcconfig'),
        matches(RegExp(r'^INFOPLIST_FILE = Runner/Info-Debug\.plist$',
            multiLine: true)));
    expect(_read('ios/Flutter/Release.xcconfig'),
        isNot(contains('INFOPLIST_FILE')));

    final pbxproj = _read('ios/Runner.xcodeproj/project.pbxproj');
    // A target-level INFOPLIST_FILE would override the xcconfig value.
    expect(
      _buildConfiguration(pbxproj, 'Debug', '/* Debug.xcconfig */'),
      isNot(contains('INFOPLIST_FILE')),
    );
    for (final name in ['Release', 'Profile']) {
      expect(
        _buildConfiguration(pbxproj, name, '/* Release.xcconfig */'),
        contains('INFOPLIST_FILE = Runner/Info.plist;'),
      );
    }
  });
}
