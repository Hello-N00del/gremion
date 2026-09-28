#!/usr/bin/env python3
"""Synapse database preflight (TASK-198). Runs before `exec /start.py` on
every boot, as the entrypoint's last step.

Reads the database block of the RENDERED homeserver.yaml (argv[1]) and asks
the server itself:

    SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()
    SHOW server_version_num

and exits non-zero, naming the value, unless collation and ctype are both C
and the major is 18. Synapse's own IncorrectDatabaseSetup check is only the
second line: it runs after Synapse has started, and it accepts any C-like
locale when `allow_unsafe_locale` is set. Zero rows, an unreadable version, a
config without a psycopg2 database and a server that never answers are
refusals too. psycopg2 ships in the upstream Synapse image.
"""

import sys
import time

REQUIRED_COLLATE = "C"
REQUIRED_MAJOR = 18
CONNECT_ATTEMPTS = 15
CONNECT_DELAY_S = 2


def evaluate(rows, server_version_num):
    """The judgement: rows are (datcollate, datctype) tuples, the version is
    server_version_num as text. Returns the list of problems (empty = pass)."""
    problems = []
    if len(rows) != 1:
        got = "no row" if not rows else f"{len(rows)} rows"
        problems.append(f"expected one pg_database row for the Synapse database, got {got}")
    else:
        collate, ctype = rows[0]
        if collate != REQUIRED_COLLATE:
            problems.append(f"datcollate is {collate!r}, Synapse needs {REQUIRED_COLLATE!r}")
        if ctype != REQUIRED_COLLATE:
            problems.append(f"datctype is {ctype!r}, Synapse needs {REQUIRED_COLLATE!r}")
    try:
        major = int(str(server_version_num).strip()) // 10000
    except ValueError:
        problems.append(f"server_version_num {server_version_num!r} is not a number")
    else:
        if major != REQUIRED_MAJOR:
            problems.append(f"the server runs PostgreSQL {major}, the pin is {REQUIRED_MAJOR}")
    return problems


def fail(msg):
    sys.stderr.write(f"[db-preflight] ERROR: {msg}\n")
    sys.exit(1)


def main(argv):
    if len(argv) != 2:
        fail("usage: db-preflight.py <rendered homeserver.yaml>")
    try:
        import yaml

        with open(argv[1]) as f:
            cfg = yaml.safe_load(f)
    except Exception as exc:  # noqa: BLE001 -- any failure to read the config is a refusal
        fail(f"cannot read {argv[1]}: {exc.__class__.__name__}")
    db = (cfg or {}).get("database") or {}
    if db.get("name") != "psycopg2":
        fail(f"database.name is {db.get('name')!r}, not psycopg2")
    args = db.get("args") or {}
    conn_args = {k: args.get(k) for k in ("user", "password", "dbname", "host", "port")}
    missing = [k for k, v in conn_args.items() if v in (None, "")]
    if missing:
        fail(f"database.args lacks {', '.join(missing)}")

    import psycopg2

    conn = None
    for attempt in range(1, CONNECT_ATTEMPTS + 1):
        try:
            conn = psycopg2.connect(connect_timeout=5, **conn_args)
            break
        except psycopg2.OperationalError as exc:
            first = str(exc).strip().splitlines()[0] if str(exc).strip() else exc.__class__.__name__
            sys.stderr.write(f"[db-preflight] attempt {attempt}/{CONNECT_ATTEMPTS}: {first}\n")
            if attempt < CONNECT_ATTEMPTS:
                time.sleep(CONNECT_DELAY_S)
    if conn is None:
        fail(f"no connection to {conn_args['host']}:{conn_args['port']}/{conn_args['dbname']} after {CONNECT_ATTEMPTS} attempts")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()")
            rows = [tuple(r) for r in cur.fetchall()]
            cur.execute("SHOW server_version_num")
            version = cur.fetchone()[0]
    finally:
        conn.close()
    problems = evaluate(rows, version)
    if problems:
        for p in problems:
            sys.stderr.write(f"[db-preflight] ERROR: {p}\n")
        sys.stderr.write("[db-preflight] refusing to start Synapse on this database\n")
        sys.exit(1)
    sys.stderr.write(f"[db-preflight] OK: {conn_args['dbname']} is C/C on PostgreSQL {REQUIRED_MAJOR}\n")


if __name__ == "__main__":
    main(sys.argv)
