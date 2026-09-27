import 'dart:async';
import 'dart:convert';
import 'dart:developer' as developer;
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:matrix/matrix.dart';
import 'package:path_provider/path_provider.dart';
import 'package:sqflite_sqlcipher/sqflite.dart' as sqlcipher;

import 'matrix_store.dart';

/// G-053: identifier of a Matrix room whose joined members are trusted to
/// auto-accept invites on the user's behalf. Typically the internal
/// council/admin room. Empty (the default) = strict mode = NO auto-accept;
/// every invite surfaces as pending in the rooms list for manual review.
///
/// Injected at build time via:
///   --dart-define=MATRIX_ADMIN_ROOM_ID=!stura-admin:matrix.example.org
const _matrixAdminRoomId = String.fromEnvironment(
  'MATRIX_ADMIN_ROOM_ID',
  defaultValue: '',
);

/// Thrown when the local OLM SQLite state is stale/corrupted.
/// The caller must:
///  1. Delete the stale Synapse device via the gateway DELETE /api/auth/matrix-device
///  2. Re-fetch a fresh Synapse token via GET /api/auth/matrix-token (no device_id)
///  3. Call loginWithToken() again with the new credentials
class MatrixOlmResetRequired implements Exception {
  const MatrixOlmResetRequired(this.staleDeviceId);
  final String staleDeviceId;
  @override
  String toString() => 'MatrixOlmResetRequired: stale device $staleDeviceId';
}

/// The failure Matrix Dart SDK 13 throws from `Client.init` when the device
/// keys of a new OLM account cannot be uploaded: Synapse already holds
/// different identity keys for this device id, i.e. the local OLM state is
/// stale (SDK 6.x said 'Upload key failed'). Pinned against the SDK source by
/// test/matrix/olm_reset_detection_test.dart.
const olmKeyUploadFailure =
    'Upload of the device keys for the new olm account failed';

/// Whether [error] from `Client.init` means the local OLM state is stale.
/// `Client.init` wraps failures in a ClientInitException whose toString() is
/// the original error's.
bool isStaleOlmStateError(Object error) =>
    error.toString().contains(olmKeyUploadFailure);

class MatrixService extends ChangeNotifier {
  MatrixService(
      {required this.homeserverUrl, FlutterSecureStorage? secureStorage})
      : _secureStorage = secureStorage ??
            const FlutterSecureStorage(
              // #245: mirror AuthService's storage options so AuthService's
              // deleteAll() on logout also evicts the cipher key, and the key
              // survives OS reboots (first_unlock) without leaving the device.
              iOptions: IOSOptions(
                  accessibility:
                      KeychainAccessibility.first_unlock_this_device),
              aOptions: AndroidOptions(encryptedSharedPreferences: true),
            );

  final String homeserverUrl;
  final FlutterSecureStorage _secureStorage;
  late Client _client;
  String? _dbPath;
  bool _initialized = false;
  bool _syncing = false;

  /// #245: FlutterSecureStorage key holding the random 256-bit SQLCipher
  /// passphrase for the Matrix DB. Generated on first run, kept in the OS
  /// keystore/keychain (never in the DB itself).
  static const _dbKeyStorageKey = 'matrix_db_cipher_key';

  /// G-047: hold onto the onSync subscription so dispose() and reconnect
  /// paths can cancel it. Discarding the returned StreamSubscription would
  /// pile additional listeners on top of stale ones on every reconnect,
  /// leak memory, and (worse) fire events into a disposed widget tree.
  StreamSubscription<SyncUpdate>? _syncSub;

  Client get client => _client;
  bool get isInitialized => _initialized;
  bool get isSyncing => _syncing;

  Future<void> init() async {
    _client = await _buildClient();
    // Do NOT call _client.init() here — no credentials yet.
    // loginWithToken() performs the single combined init+connect call.
    _initialized = true;
    notifyListeners();
  }

  /// Creates a fresh Client backed by a new SQLCipher-encrypted SQLite
  /// connection (#245). The cipher key comes from [_getOrCreateDbKey]; on
  /// first run under SQLCipher any pre-existing *plaintext* DB is deleted
  /// (the FluffyChat migration pattern) since it cannot be opened with the
  /// new key — the client simply re-syncs from Synapse.
  Future<Client> _buildClient() async {
    final dir = await getApplicationSupportDirectory();
    _dbPath = '${dir.path}/stura_matrix.db';
    final key = await _getOrCreateDbKey();
    final store = await openMatrixStore(path: _dbPath!, password: key);
    return buildMatrixClient(store);
  }

  /// #245: return the stored SQLCipher key, or mint a new random 256-bit key
  /// on first run. When minting (no key yet) any DB file already at [_dbPath]
  /// is a legacy plaintext DB the new key cannot decrypt, so it is deleted
  /// before the fresh encrypted DB is opened.
  Future<String> _getOrCreateDbKey() async {
    final existing = await _secureStorage.read(key: _dbKeyStorageKey);
    if (existing != null && existing.isNotEmpty) return existing;
    // First run under SQLCipher — drop any legacy plaintext DB.
    final path = _dbPath;
    if (path != null) {
      try {
        await sqlcipher.deleteDatabase(path);
      } catch (e) {
        developer.log('Legacy plaintext Matrix DB delete failed',
            name: 'MatrixService', error: e);
      }
    }
    final key = _generateDbKey();
    await _secureStorage.write(key: _dbKeyStorageKey, value: key);
    return key;
  }

  /// Generate a random 256-bit key, base64url-encoded into a stable string
  /// passphrase for SQLCipher.
  static String _generateDbKey() {
    final rng = Random.secure();
    final bytes = Uint8List(32);
    for (var i = 0; i < bytes.length; i++) {
      bytes[i] = rng.nextInt(256);
    }
    return base64UrlEncode(bytes);
  }

  /// Log in using a pre-obtained Matrix access token (from Platform API).
  ///
  /// Throws [MatrixOlmResetRequired] when the local OLM DB is stale — the
  /// caller must delete the old Synapse device, get a fresh token (no device_id),
  /// and call loginWithToken() again with the new credentials.
  Future<void> loginWithToken(String accessToken, String userId,
      {String? deviceId}) async {
    final effectiveDeviceId =
        deviceId ?? 'stura_${userId.split(':').first.substring(1)}';
    try {
      await _client.init(
        newToken: accessToken,
        newUserID: userId,
        newDeviceID: effectiveDeviceId,
        newHomeserver: Uri.parse(homeserverUrl),
      );
    } catch (e) {
      if (isStaleOlmStateError(e)) {
        // The local OLM key material doesn't match what Synapse has for this
        // device — Synapse rejects re-uploads with a different ed25519 identity
        // key. Delete the local DB so the next login starts with fresh OLM state,
        // then throw so the caller can delete the Synapse device and re-fetch
        // a fresh access token before retrying.
        // G-091: developer.log so the OLM recovery diagnostic is auto-filtered
        // out of release builds rather than printed to logcat/stdout.
        developer.log(
          'Stale OLM state — clearing local DB, caller must reset Synapse device.',
          name: 'MatrixService',
        );
        try {
          await _client.clearCache();
        } catch (_) {}
        await _disposeClient();
        if (_dbPath != null) {
          try {
            // Delete only the DB file — keep the SQLCipher key so the rebuilt
            // DB (via _buildClient) reuses it; this is an OLM reset, not a
            // logout, so we want a fresh DB under the same key.
            await sqlcipher.deleteDatabase(_dbPath!);
          } catch (_) {}
        }
        _client = await _buildClient();
        throw MatrixOlmResetRequired(effectiveDeviceId);
      }
      rethrow;
    }

    _connectSyncListener();
  }

  void _connectSyncListener() {
    // G-047: cancel any prior subscription before re-subscribing — prevents
    // double-fire of _autoAcceptInvites + notifyListeners after a reconnect.
    _syncSub?.cancel();
    _syncSub = _client.onSync.stream.listen((_) {
      _autoAcceptInvites();
      notifyListeners();
    });
    _syncing = true;
    notifyListeners();
  }

  Future<void> _autoAcceptInvites() async {
    final invited =
        _client.rooms.where((r) => r.membership == Membership.invite).toList();
    // Matrix server_name comes from our own user id (@local:server_name), not
    // the homeserver URL host — those two are independent (e.g. user id
    // @alice:example.com can live behind https://matrix.example.com).
    final ourServer = _serverOf(_client.userID);
    if (ourServer == null) {
      developer.log(
        'Cannot determine own Matrix server_name — skipping auto-accept.',
        name: 'MatrixService',
      );
      return;
    }

    // G-053: strict-mode gate. Without an admin room configured at build time,
    // we never auto-accept — every invite surfaces as pending. Same applies if
    // the configured admin room isn't in our client state yet (could be just
    // started; we'll get another chance on the next sync tick).
    if (_matrixAdminRoomId.isEmpty) {
      if (invited.isNotEmpty) {
        developer.log(
          '${invited.length} invite(s) pending; MATRIX_ADMIN_ROOM_ID not set → no auto-accept (strict mode).',
          name: 'MatrixService',
        );
      }
      return;
    }
    final adminRoom = _client.getRoomById(_matrixAdminRoomId);
    if (adminRoom == null) {
      developer.log(
        'Admin room $_matrixAdminRoomId not in client state — refusing all auto-accepts this tick.',
        name: 'MatrixService',
      );
      return;
    }
    final adminUserIds = adminRoom
        .getParticipants(const [Membership.join])
        .map((u) => u.id)
        .toSet();

    for (final room in invited) {
      final invitedBy = _inviterOf(room);
      if (invitedBy == null) {
        developer.log(
          'Invite ${room.id}: no inviter id, skipping.',
          name: 'MatrixService',
        );
        continue;
      }
      final inviterServer = _serverOf(invitedBy);
      if (inviterServer == null || inviterServer != ourServer) {
        developer.log(
          'Invite ${room.id} from $invitedBy on ${inviterServer ?? '<unknown>'} rejected (off-server, not $ourServer).',
          name: 'MatrixService',
        );
        continue;
      }
      // G-053: inviter must be a joined member of the configured admin room.
      // A compromised account on the same Synapse HS cannot force-join the
      // user into arbitrary rooms unless that account is already in the
      // admin room (which the operator controls).
      if (!adminUserIds.contains(invitedBy)) {
        developer.log(
          'Invite ${room.id} from $invitedBy rejected (not in admin room $_matrixAdminRoomId).',
          name: 'MatrixService',
        );
        continue;
      }
      try {
        await room.join();
        developer.log(
          'Auto-joined room ${room.id} (${room.getLocalizedDisplayname()}); inviter $invitedBy verified admin-room member.',
          name: 'MatrixService',
        );
        notifyListeners();
      } catch (e) {
        developer.log('Failed to auto-join room ${room.id}',
            name: 'MatrixService', error: e);
      }
    }
  }

  String? _inviterOf(Room room) {
    // The inviter is the sender of the m.room.member invite targeting us.
    try {
      final me = _client.userID;
      if (me == null) return null;
      final state = room.getState('m.room.member', me);
      return state?.senderId;
    } catch (_) {
      return null;
    }
  }

  /// Extract the `server_name` part of a Matrix user id `@local:server_name`.
  /// Returns null if the id is malformed or missing.
  static String? _serverOf(String? mxid) {
    if (mxid == null || mxid.isEmpty) return null;
    final idx = mxid.indexOf(':');
    if (idx < 0 || idx == mxid.length - 1) return null;
    final server = mxid.substring(idx + 1);
    return server.isEmpty ? null : server;
  }

  List<Room> getRooms() {
    if (!_initialized) return [];
    return _client.rooms;
  }

  Future<void> sendMessage(String roomId, String body) async {
    final room = _client.getRoomById(roomId);
    if (room == null) throw StateError('Room $roomId not found');
    await room.sendTextEvent(body);
  }

  Future<Timeline> getTimeline(String roomId) async {
    final room = _client.getRoomById(roomId);
    if (room == null) throw StateError('Room $roomId not found');
    return room.getTimeline();
  }

  /// Full Matrix logout (#233): revoke the Synapse access token server-side
  /// and clear the in-memory cache. Local cleanup proceeds even if the server
  /// is unreachable (offline logout) — errors are logged, never rethrown — so
  /// the caller can still wipe the on-disk DB via [deleteLocalDatabase].
  Future<void> logout() async {
    // G-047: cancel the sync subscription BEFORE clearCache() to avoid the
    // listener firing one more time on the clearCache()-induced sync update.
    await _syncSub?.cancel();
    _syncSub = null;
    if (_initialized) {
      try {
        // Revokes the Synapse bearer token server-side.
        await _client.logout();
      } catch (e) {
        developer.log('Matrix _client.logout failed (offline?) — continuing',
            name: 'MatrixService', error: e);
      }
      try {
        await _client.clearCache();
      } catch (_) {}
    }
    _syncing = false;
    notifyListeners();
  }

  /// #233: delete the on-disk Matrix DB file AND evict the SQLCipher key so
  /// the Synapse token, refresh_token, pickled OLM identity keys and decrypted
  /// message cache do not survive on disk after logout. Belt-and-suspenders:
  /// AuthService.logout()'s deleteAll() also evicts the key (shared storage
  /// options), but deleting it here removes any dependency on that ordering.
  /// A fresh key + DB are minted on the next login.
  ///
  /// After deletion a fresh [_buildClient] replaces the (now DB-less) client
  /// so a re-login without an app restart has a clean client to init() — the
  /// same rebuild the OLM-reset path performs. The rebuild mints a new key +
  /// encrypted DB (key was just evicted), which is exactly what we want.
  Future<void> deleteLocalDatabase() async {
    if (_initialized) await _disposeClient();
    final path = _dbPath;
    if (path != null) {
      try {
        await sqlcipher.deleteDatabase(path);
      } catch (e) {
        developer.log('Matrix DB delete failed',
            name: 'MatrixService', error: e);
      }
    }
    try {
      await _secureStorage.delete(key: _dbKeyStorageKey);
    } catch (_) {}
    try {
      _client = await _buildClient();
      _initialized = true;
    } catch (e) {
      // e.g. no platform channel (unit tests) or storage unavailable — leave
      // the service uninitialised; the next login/init() will rebuild.
      _initialized = false;
      developer.log('Matrix client rebuild after logout failed',
          name: 'MatrixService', error: e);
    }
    notifyListeners();
  }

  /// Closes the current client and its database connection before the DB
  /// file is deleted and a new client is built on the same path, so no
  /// stale connection to the deleted file stays open.
  Future<void> _disposeClient() async {
    try {
      await _client.dispose(closeDatabase: true);
    } catch (e) {
      developer.log('Matrix client dispose failed',
          name: 'MatrixService', error: e);
    }
  }

  @override
  void dispose() {
    // G-047: idempotent — safe to call multiple times.
    _syncSub?.cancel();
    _syncSub = null;
    _syncing = false;
    super.dispose();
  }
}
