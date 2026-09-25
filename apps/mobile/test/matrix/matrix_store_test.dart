// TASK-166 guard 3: on Matrix Dart SDK 13 the app builds its Client on an
// SQLCipher-encrypted MatrixSdkDatabase, and the store written by SDK 6.2.0
// still opens as-is. No homeserver is contacted.
//
// On device the database comes from sqflite_sqlcipher (a platform plugin
// that does not exist under `flutter test`). Here the same sqflite_common
// Database contract is served by sqflite_common_ffi on SQLCipher (package
// sqlite3 looks up the system SQLCipher library on host platforms, see the
// hooks block in pubspec.yaml), and the key is applied with the SDK's own
// SQfLiteEncryptionHelper.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:matrix/matrix.dart';
import 'package:mocktail/mocktail.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:stura/matrix/matrix_store.dart';

const _fixtureKey = 'task166-fixture-key-not-a-secret';

Future<Database> _openWithSqlCipherFfi(String path, String password) {
  final helper = SQfLiteEncryptionHelper(
    factory: databaseFactoryFfi,
    path: path,
    cipher: password,
  );
  return databaseFactoryFfi.openDatabase(
    path,
    options: OpenDatabaseOptions(
      onConfigure: helper.applyPragmaKey,
      singleInstance: false,
    ),
  );
}

Future<MatrixSdkDatabase> _openStore(String path, String password) =>
    openMatrixStore(
      path: path,
      password: password,
      open: _openWithSqlCipherFfi,
      sqfliteFactory: databaseFactoryFfi,
    );

class _PlainSqliteDatabase extends Mock implements Database {}

void main() {
  setUpAll(() async {
    // Turn a missing host SQLCipher library into an instruction instead of
    // a bare dlopen error (see "Prerequisites" in README.md).
    try {
      final probe = await databaseFactoryFfi.openDatabase(
        inMemoryDatabasePath,
        options: OpenDatabaseOptions(singleInstance: false),
      );
      final version = await probe.rawQuery('PRAGMA cipher_version');
      await probe.close();
      if (version.isEmpty) throw StateError('library is not SQLCipher');
    } catch (e) {
      fail('test/matrix needs SQLCipher as a system library on this host '
          '(libsqlcipher / sqlcipher.dll, see README.md "Prerequisites"): $e');
    }
  });

  late Directory tmp;

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('task166_matrix_store_');
  });

  tearDown(() async {
    await tmp.delete(recursive: true);
  });

  test('pins the Matrix SDK store schema this app was verified against', () {
    // A new schema version means a new storage contract: re-run the
    // 6.2.0 fixture test below against it and re-read the CHANGELOG
    // before bumping this number.
    expect(MatrixSdkDatabase.version, 11);
  });

  test('builds a Client on an SQLCipher-encrypted MatrixSdkDatabase, '
      'with no server', () async {
    final path = '${tmp.path}/stura_matrix.db';
    final store = await _openStore(path, 'k' * 43);
    final client = buildMatrixClient(
      store,
      nativeImplementations: NativeImplementations.dummy,
    );

    expect(client.clientName, matrixClientName);
    expect(client.database, same(store));

    // No stored credentials: init() reads the store and settles logged out
    // without any network call.
    await client.init(waitForFirstSync: false);
    expect(client.isLogged(), isFalse);
    expect(client.onLoginStateChanged.value, LoginState.loggedOut);

    await store.storeAccountData('org.gremion.probe', {'at': 'rest'});
    await client.dispose(closeDatabase: true);

    // Encrypted at rest: no SQLite header, no plaintext content.
    final bytes = File(path).readAsBytesSync();
    expect(ascii.decode(bytes.sublist(0, 15), allowInvalid: true),
        isNot('SQLite format 3'));
    expect(latin1.decode(bytes).contains('org.gremion.probe'), isFalse);
  });

  test('a wrong key fails loudly instead of opening an empty store', () async {
    final path = '${tmp.path}/stura_matrix.db';
    final store = await _openStore(path, 'right-key');
    await store.storeAccountData('org.gremion.probe', {'x': 1});
    await store.close();

    await expectLater(
      _openStore(path, 'wrong-key'),
      throwsA(isA<DatabaseException>().having(
          (e) => e.toString(), 'message', contains('not a database'))),
    );
  });

  test('refuses a database without SQLCipher (would be plaintext)', () async {
    final plain = _PlainSqliteDatabase();
    when(() => plain.rawQuery(any())).thenAnswer((_) async => []);

    await expectLater(
      openMatrixStore(
        path: 'unused',
        password: 'unused',
        open: (_, __) async => plain,
      ),
      throwsA(isA<StateError>()),
    );
  });

  test('refuses a store that ends up unencrypted on disk (key not applied)',
      () async {
    // SQLCipher is loaded (cipher_version answers) but the opener "forgets"
    // the key, as a device opener that dropped `password:` would.
    final path = '${tmp.path}/stura_matrix.db';
    await expectLater(
      openMatrixStore(
        path: path,
        password: 'unused',
        open: (p, _) => databaseFactoryFfi.openDatabase(
          p,
          options: OpenDatabaseOptions(singleInstance: false),
        ),
        sqfliteFactory: databaseFactoryFfi,
      ),
      throwsA(isA<StateError>()),
    );
  });

  test('opens the store written by SDK 6.2.0 without migrating it away',
      () async {
    final path = '${tmp.path}/stura_matrix.db';
    File('test/matrix/fixtures/matrix_6_2_0_store.sqlite').copySync(path);

    final store = await _openStore(path, _fixtureKey);

    final account = await store.getClient(matrixClientName);
    expect(account, isNotNull, reason: 'client row lost');
    expect(account!['homeserver_url'], 'https://matrix.invalid');
    expect(account['user_id'], '@fixture:matrix.invalid');
    expect(account['device_id'], 'FIXTUREDEVICE');
    expect(account['token'], 'fixture-access-token');
    // clearCache() (the SDK's default version-upgrade path) would have
    // nulled prev_batch and dropped account data.
    expect(account['prev_batch'], 'fixture_prev_batch');
    final accountData = await store.getAccountData();
    expect(accountData['org.gremion.fixture']?.content,
        {'written_by': 'matrix 6.2.0'});
    expect(
      await store.deviceIdSeen('@fixture:matrix.invalid', 'FIXTUREDEVICE'),
      'fixture-public-keys',
    );
    await store.close();
  });
}
