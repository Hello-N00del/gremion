// TASK-166 review fix: MatrixService turns a failed first key upload into
// MatrixOlmResetRequired (the app then deletes the stale Synapse device and
// logs in again). SDK 13 reworded that failure and wraps it in
// ClientInitException, so the detection is pinned to the SDK's own text.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
// ClientInitException is not exported by package:matrix/matrix.dart; the
// real class is used so the test follows its toString().
// ignore: implementation_imports
import 'package:matrix/src/utils/client_init_exception.dart';
import 'package:stura/matrix/matrix_service.dart';

/// Root directory of the resolved `matrix` package, from package_config.
Directory _matrixPackageRoot() {
  final config = jsonDecode(
    File('.dart_tool/package_config.json').readAsStringSync(),
  ) as Map<String, dynamic>;
  final entry = (config['packages'] as List)
      .cast<Map<String, dynamic>>()
      .singleWhere((p) => p['name'] == 'matrix');
  final configUri = File('.dart_tool/package_config.json').absolute.uri;
  return Directory.fromUri(configUri.resolve(entry['rootUri'] as String));
}

void main() {
  test('the SDK still throws the key-upload failure this app detects', () {
    final source = File(
      '${_matrixPackageRoot().path}/lib/encryption/olm_manager.dart',
    ).readAsStringSync();
    expect(source, contains("throw ('$olmKeyUploadFailure')"));
  });

  test('detects the SDK 13 failure as wrapped by Client.init', () {
    expect(isStaleOlmStateError(ClientInitException(olmKeyUploadFailure)),
        isTrue);
    expect(isStaleOlmStateError(olmKeyUploadFailure), isTrue);
  });

  test('does not treat other init failures as stale OLM state', () {
    expect(
      isStaleOlmStateError(ClientInitException(Exception('Connection refused'))),
      isFalse,
    );
    expect(isStaleOlmStateError(StateError('Upload')), isFalse);
  });
}
