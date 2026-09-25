enum StuRaRole { guest, member, finance, councilAdmin, itAdmin }

class UserSession {
  final String accessToken;
  final String refreshToken;
  final String idToken;
  final StuRaRole role;
  final String matrixUserId;

  /// The Synapse device ID associated with matrixToken.
  /// Must match exactly or E2E key upload will fail.
  final String matrixDeviceId;

  /// Real Synapse access token, obtained by exchanging the Keycloak JWT
  /// via /api/auth/matrix-token on the gateway. Empty until the first login
  /// after this feature was deployed.
  final String matrixToken;
  final String homeserverUrl;

  const UserSession({
    required this.accessToken,
    required this.refreshToken,
    required this.idToken,
    required this.role,
    required this.matrixUserId,
    required this.matrixDeviceId,
    required this.matrixToken,
    required this.homeserverUrl,
  });

  factory UserSession.fromJson(Map<String, dynamic> j) => UserSession(
        accessToken: j['access_token'] as String,
        refreshToken: j['refresh_token'] as String,
        idToken: j['id_token'] as String,
        role: switch (j['role'] as String?) {
          'it-admin' => StuRaRole.itAdmin,
          'council-admin' => StuRaRole.councilAdmin,
          'finance' => StuRaRole.finance,
          'member' => StuRaRole.member,
          _ => StuRaRole.guest,
        },
        matrixUserId: (j['matrix_user_id'] as String?) ?? '',
        matrixDeviceId: (j['matrix_device_id'] as String?) ?? '',
        matrixToken: (j['matrix_token'] as String?) ?? '',
        homeserverUrl: j['homeserver_url'] as String,
      );

  bool canWrite() => role.index >= StuRaRole.member.index;
}
