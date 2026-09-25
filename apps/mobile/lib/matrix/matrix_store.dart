import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_vodozemac/flutter_vodozemac.dart' as vod;
import 'package:matrix/matrix.dart';
// #245: SQLCipher-backed sqflite. Its Database extends the sqflite_common
// Database that MatrixSdkDatabase.init accepts, and openDatabase() takes a
// `password:` so the whole DB file (Synapse token, refresh_token, pickled
// OLM identity keys, decrypted message cache) is encrypted at rest.
import 'package:sqflite_sqlcipher/sqflite.dart' as sqlcipher;

/// Client name and MatrixSdkDatabase name of the app's Matrix store. Part of
/// the on-disk contract: the stored client row is keyed by it.
const matrixClientName = 'stura';

/// Opens the SQLite database at `path`, encrypted with `password`.
typedef EncryptedDatabaseOpener = Future<sqlcipher.Database> Function(
  String path,
  String password,
);

/// The device opener: sqflite_sqlcipher's bundled SQLCipher.
Future<sqlcipher.Database> openSqlCipherDatabase(
  String path,
  String password,
) =>
    sqlcipher.openDatabase(path, password: password);

/// Opens the encrypted Matrix store at [path] with Matrix Dart SDK 13's
/// MatrixSdkDatabase (schema version 11, unchanged since SDK 6.2.0).
///
/// Fails loudly rather than degrading:
/// - [StateError] if the opened database is not SQLCipher: a plain SQLite
///   library ignores `PRAGMA key` and would silently store everything in
///   plaintext;
/// - the driver's exception if [password] does not decrypt an existing file
///   (the key is checked here with a read, before the SDK touches the store);
/// - [StateError] if, once the SDK has written its schema, the file on disk
///   is plain SQLite anyway (an opener that did not apply the key).
Future<MatrixSdkDatabase> openMatrixStore({
  required String path,
  required String password,
  EncryptedDatabaseOpener open = openSqlCipherDatabase,
  sqlcipher.DatabaseFactory? sqfliteFactory,
}) async {
  final db = await open(path, password);
  try {
    final cipherVersion = await db.rawQuery('PRAGMA cipher_version');
    if (cipherVersion.isEmpty) {
      throw StateError(
        'Matrix store opened without SQLCipher; refusing to use a '
        'plaintext database.',
      );
    }
    await db.rawQuery('SELECT count(*) FROM sqlite_master');
  } catch (_) {
    // Report the refusal, not a secondary failure while closing.
    try {
      await db.close();
    } catch (_) {}
    rethrow;
  }
  final store = await MatrixSdkDatabase.init(
    matrixClientName,
    database: db,
    sqfliteFactory: sqfliteFactory,
  );
  if (await _isPlaintextSqlite(path)) {
    try {
      await store.close();
    } catch (_) {}
    throw StateError(
      'Matrix store is plaintext SQLite on disk; the SQLCipher key was not '
      'applied. Refusing to use it.',
    );
  }
  return store;
}

/// Whether the file at [path] starts with the plain SQLite header. An
/// SQLCipher file starts with random salt instead.
Future<bool> _isPlaintextSqlite(String path) async {
  final file = File(path);
  if (!await file.exists()) return false;
  final raf = await file.open();
  try {
    final header = await raf.read(16);
    return latin1.decode(header, allowInvalid: true) == 'SQLite format 3\x00';
  } finally {
    await raf.close();
  }
}

/// The app's Matrix [Client] over [store]. Construction does not contact a
/// server; [Client.init] with credentials does.
Client buildMatrixClient(
  MatrixSdkDatabase store, {
  NativeImplementations? nativeImplementations,
}) =>
    Client(
      matrixClientName,
      database: store,
      nativeImplementations: nativeImplementations ??
          NativeImplementationsIsolate(compute, vodozemacInit: vod.init),
    );
