#!/usr/bin/env python3
"""Inject the identity provider realm's RS256 public key into the rendered
homeserver.yaml (TASK-198; baked as /inject-jwt-key.py, run by the
entrypoint between the render and the database preflight).

Fetches KEYCLOAK_FETCH_URL, reads the realm document's `public_key` (a
base64 SPKI string) and writes it into jwt_config.secret as a PEM block --
compose env vars cannot carry a multi-line PEM (newlines collapse, breaking
authlib's PEM framing parser).

Exit status, which the entrypoint's retry loop reads:
  0  the key was injected
  3  the realm does not serve a usable key set (yet): a refused connection, an
     HTTP error page, a body that is not JSON, a document without a usable
     public_key. The config file is left exactly as rendered.
  1  anything else (no fetch URL, a scheme other than http(s), a config that
     cannot be read): retrying cannot help.
The container never boots without a key while the JWT login is on; the
entrypoint retries on 3 for a bounded time and then ends the container.
"""

import base64
import binascii
import http.client
import json
import os
import sys
import textwrap
import urllib.error
import urllib.parse
import urllib.request

EXIT_NO_KEY_YET = 3
FETCH_TIMEOUT_S = 5


def url_problem(fetch_url):
    """Why the URL can never be fetched (a permanent configuration fault), or None."""
    if not fetch_url:
        return "KEYCLOAK_FETCH_URL is empty"
    # KEYCLOAK_FETCH_URL is operator config, but refuse anything that is not
    # http(s) so a file:// (or other urllib scheme) can never be read.
    if urllib.parse.urlsplit(fetch_url).scheme not in ("http", "https"):
        return "KEYCLOAK_FETCH_URL is not http(s)"
    return None


def usable_key(public_key):
    """True for a non-empty base64 string (the SPKI body); never logged."""
    if not public_key or not isinstance(public_key, str):
        return False
    try:
        return len(base64.b64decode(public_key, validate=True)) > 0
    except (binascii.Error, ValueError):
        return False


def fetch_pem(fetch_url):
    """The realm key as PEM, or None (with the reason on stderr)."""
    problem = url_problem(fetch_url)
    if problem:
        if fetch_url:
            sys.stderr.write(f"[gremion-synapse] realm key fetch refused: {problem}\n")
        return None
    try:
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with urllib.request.urlopen(fetch_url, timeout=FETCH_TIMEOUT_S) as r:
            realm_data = json.load(r)
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException) as exc:
        sys.stderr.write(f"[gremion-synapse] realm key fetch failed: {exc}\n")
        return None
    public_key = realm_data.get("public_key") if isinstance(realm_data, dict) else None
    if not usable_key(public_key):
        sys.stderr.write("[gremion-synapse] realm response has no usable public_key field\n")
        return None
    pem_body = "\n".join(textwrap.wrap(public_key, 64))
    return f"-----BEGIN PUBLIC KEY-----\n{pem_body}\n-----END PUBLIC KEY-----\n"


def apply(cfg, pem):
    """Writes the key into cfg (in place), or, given no key, switches JWT login
    off in a shape Synapse still loads. main() never passes no key: it refuses
    instead (exit 3), so the running homeserver always has the key."""
    jwt_cfg = cfg.setdefault("jwt_config", {})
    if pem:
        jwt_cfg["secret"] = pem
        sys.stderr.write("[gremion-synapse] Injected the realm public key into jwt_config.secret\n")
    else:
        # The secret key STAYS (empty): Synapse's JWTConfig reads
        # jwt_config["secret"] whenever the block exists, enabled or not, and
        # a missing key crash-loops it (measured on 1.160, scratch proof 7c).
        jwt_cfg["enabled"] = False
        jwt_cfg["secret"] = ""
        sys.stderr.write("[gremion-synapse] WARNING: jwt_config disabled — realm public key unavailable\n")
    return cfg


def main(argv):
    import yaml

    config_path = argv[1]
    fetch_url = os.environ.get("KEYCLOAK_FETCH_URL", "").strip()
    problem = url_problem(fetch_url)
    if problem:
        sys.stderr.write(f"[gremion-synapse] ERROR: {problem}\n")
        return 1
    pem = fetch_pem(fetch_url)
    if not pem:
        return EXIT_NO_KEY_YET
    with open(config_path) as f:
        cfg = yaml.safe_load(f)
    apply(cfg, pem)
    with open(config_path, "w") as f:
        yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
