# Matrix store fixtures

`matrix_6_2_0_store.sqlite` is an SQLCipher-encrypted Matrix store written
by Matrix Dart SDK 6.2.0 (`MatrixSdkDatabase`, schema version 11) through
`sqflite_common_ffi` and SQLCipher 4.5.6. It holds fake data only:

- key (PRAGMA key): `task166-fixture-key-not-a-secret`
- client `stura`: homeserver `https://matrix.invalid`, user
  `@fixture:matrix.invalid`, device `FIXTUREDEVICE`, token
  `fixture-access-token`, prev_batch `fixture_prev_batch`
- account data `org.gremion.fixture` = `{"written_by": "matrix 6.2.0"}`
- seen device `@fixture:matrix.invalid` / `FIXTUREDEVICE`

`test/matrix/matrix_store_test.dart` opens a copy with SDK 13 to prove the
6.2.0 -> 13 upgrade reads the old encrypted store as-is, without a
cache-clearing migration.
