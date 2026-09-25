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
///   (the key is checked here with a read, before the SDK touches the store).
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
  return MatrixSdkDatabase.init(
    matrixClientName,
    database: db,
    sqfliteFactory: sqfliteFactory,
  );
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
