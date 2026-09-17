#!/usr/bin/env python3
"""Render docker/keycloak/realm-export.base.json into a realm document a test
run can create over the Keycloak Admin API.

B-01 (spec B T.4) deleted the boot import: a freshly started Keycloak in this
kernel has `master` and nothing else. In production the per-tenant realm is
composed by buildTenantRealmDoc at tenant-create time
(gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts) and the entrypoint
that drives it is a later unit. Until it lands, the CI integration job still has
to have a realm before test/integration/login-theme.bats can read what a user is
SERVED, so this fixture resolves the same template sentinels the provisioner
does -- realm name, apex domain, sslRequired, the platform SMTP block
(gremion#6) and the confidential client secrets -- and REFUSES to emit a
document in which any `__SENTINEL__` survived.

This is a TEST FIXTURE. It is not on the deploy path, no service reads its
output, and it deliberately does not reimplement the provisioner's module
composition or its #240 URI restriction: it renders the template as committed,
which is exactly what makes it useful as an input to a served-page assertion
(a template whose loginTheme regressed produces a realm whose login page fails
the theme assertions).

Usage:
    render-realm-fixture.py --realm <name> [--apex <domain>]
                            [--ssl-required none|external|all] [--base <path>]
                            [--smtp-host <host>] [--smtp-port <port>]

Client secrets are read from the matching environment variable when set
(GREMION_UI_OIDC_CLIENT_SECRET for `__GREMION_UI_OIDC_CLIENT_SECRET__`, and so
on) and generated otherwise. The rendered document is written to stdout.

The SMTP sender renders at the SINK host by default, never at the platform
submission host: the CI integration job creates this realm in a live Keycloak,
and a fixture that inherited the real relay would make a test run authenticate
to it and deliver real mail. The starttls/ssl carrier follows smtpServerBlock()
in gremion-ui/src/lib/server/tenant/provisioner/realm-doc.ts -- 465 is the one
implicit-TLS port, every other port negotiates STARTTLS -- so the fixture and
the provisioner cannot drift into proving a transport the product never uses.
"""

import argparse
import json
import os
import re
import secrets
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_BASE = REPO_ROOT / "docker" / "keycloak" / "realm-export.base.json"
SENTINEL = re.compile(r"__[A-Z0-9_]+__")
SECRET_SENTINEL = re.compile(r"__([A-Z0-9_]*_CLIENT_SECRET)__")


def json_escape(value: str) -> str:
    """Escape a value for substitution into the RAW template text.

    Substitution happens before json.loads (every sentinel sits inside a string
    literal), so a value carrying a quote or a backslash -- an env-supplied SMTP
    password, say -- would otherwise produce a document that no longer parses,
    and the failure would read as a corrupt template.
    """
    return json.dumps(value)[1:-1]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--realm", required=True, help="realm name to stamp over __REALM_NAME__")
    ap.add_argument("--apex", default="ci.local", help="apex domain for __APEX_DOMAIN__")
    # `none` by default on purpose: the fixture realm is reached over plain
    # http://localhost in a test stack. A provisioned realm is pinned to `all`
    # by buildTenantRealmDoc (realm-doc.ts) and nothing here changes that.
    ap.add_argument("--ssl-required", default="none", choices=["none", "external", "all"])
    ap.add_argument("--base", default=str(DEFAULT_BASE), help="path to realm-export.base.json")
    # `null-sink` on purpose: an unroutable name (the alias gremion-neuter gives
    # its discard sink), so a rendered fixture realm cannot reach a real relay.
    ap.add_argument("--smtp-host", default="null-sink", help="host for __SMTP_HOST__")
    ap.add_argument("--smtp-port", type=int, default=587, help="port for __SMTP_PORT__")
    args = ap.parse_args()

    # Mirrors smtpServerBlock's own refusal (realm-doc.ts).
    if not 1 <= args.smtp_port <= 65535:
        print(
            f"render-realm-fixture: refusing a non-port SMTP port {args.smtp_port}",
            file=sys.stderr,
        )
        return 1

    base_path = Path(args.base)
    if not base_path.is_file():
        print(f"render-realm-fixture: {base_path} does not exist", file=sys.stderr)
        return 1
    raw = base_path.read_text(encoding="utf-8")

    raw = raw.replace("__REALM_NAME__", args.realm)
    raw = raw.replace("__APEX_DOMAIN__", args.apex)
    raw = raw.replace("__SSL_REQUIRED__", args.ssl_required)
    for name in sorted(set(SECRET_SENTINEL.findall(raw))):
        value = os.environ.get(name) or secrets.token_urlsafe(32)
        raw = raw.replace(f"__{name}__", json_escape(value))

    # gremion#6: the platform SMTP block. Mirrors smtpServerBlock() key for key,
    # TLS carrier included, because this renderer is the SECOND consumer of the
    # template -- .github/workflows/ci.yml pipes this stdout straight into the
    # Keycloak Admin API, so a sentinel this program does not know is an
    # integration lane that cannot create its realm at all.
    implicit_tls = args.smtp_port == 465
    smtp = {
        "HOST": args.smtp_host,
        "PORT": str(args.smtp_port),
        "FROM": f"no-reply@{args.apex}",
        "USER": f"platform@{args.apex}",
        # Generated, never a committed literal; an env value is honoured so a
        # caller that DOES want a reachable sender can supply one explicitly.
        "PASSWORD": os.environ.get("PLATFORM_SMTP_PASSWORD") or secrets.token_urlsafe(24),
        "STARTTLS": "false" if implicit_tls else "true",
        "SSL": "true" if implicit_tls else "false",
    }
    for key, value in smtp.items():
        raw = raw.replace(f"__SMTP_{key}__", json_escape(value))

    # The refusal that makes this fixture safe to feed to a live Keycloak: a
    # sentinel that reaches the Admin API is a realm nobody can log into, and
    # the resulting failure reads as a theme bug three suites later.
    left = sorted(set(SENTINEL.findall(raw)))
    if left:
        print(
            "render-realm-fixture: refusing to emit a realm with unresolved "
            f"sentinel(s): {', '.join(left)}",
            file=sys.stderr,
        )
        return 1

    doc = json.loads(raw)
    if doc.get("realm") != args.realm:
        print(
            f"render-realm-fixture: rendered realm is {doc.get('realm')!r}, expected {args.realm!r}",
            file=sys.stderr,
        )
        return 1
    if not doc.get("loginTheme"):
        print("render-realm-fixture: the template declares no loginTheme", file=sys.stderr)
        return 1

    json.dump(doc, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
