# kcadm output measured on Keycloak 26.6.1

Every file here is the verbatim output of `kcadm.sh` against the digest-pinned
image of `docker-compose.yml` (quay.io/keycloak/keycloak 26.6.1), started as a
scratch `start-dev` container, so the unit tests model what Keycloak does and
not what a shim assumes. No file holds a credential: a stamped password reads
back as the mask `**********`, and the stamps used are throwaway.

## smtpServer read-back (TASK-043b F2)

- `get-realm-fields-smtpServer.json` / `get-realms-fields-realm-smtpServer.json`:
  a BARE `--fields smtpServer` answers the map EMPTY whatever the realm holds.
- `get-realm-fields-smtpServer-star.json` / `get-realms-fields-realm-smtpServer-star.json`:
  `--fields 'smtpServer(*)'` returns the fields.

## Un-stamping a customer realm (TASK-043c P2, Qc4)

A suspended customer's realm must stop authenticating as its revoked
principal. Four payloads were sent with `kcadm update realms/<r> -f -` to a
realm stamped with `kc-<token>@<domain>` (auth true, password set):

| payload (`smtpServer`)                                          | result                                                                  |
|-----------------------------------------------------------------|-------------------------------------------------------------------------|
| `{..., auth:"false", user:"", from:"", password:""}` (TASK-043 revoke) | REFUSED, exit 1: `update-realm-smtpServer-empty-from.stderr`; the realm keeps its stamp |
| `{..., auth:"false"}` with user/from/password omitted           | REFUSED, exit 1: `update-realm-smtpServer-omitted-from.stderr`          |
| `{..., auth:"false", user:"", from:"<principal>", password:""}` | accepted; reads back with `from` kept and no user, no password, auth false |
| `{}`                                                            | accepted; reads back `{}` (`get-realm-fields-smtpServer-star-unstamped.json`) |

`{}` is the Qc4 choice: the first accepted shape, and the only one that leaves
nothing behind (no `from`, no host, no port). It was also accepted on a DISABLED
realm (what a suspended realm is), twice in a row, on a realm that never had a
sender, and a normal stamp applied again afterwards (the resume path).

`get-realm-fields-smtpServer-star-customer-stamped.json` is the read-back of the
stamped realm before any of these updates.
