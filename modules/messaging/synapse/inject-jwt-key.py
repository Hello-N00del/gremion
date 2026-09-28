#!/usr/bin/env python3
"""Inject the identity provider realm's RS256 public key into the rendered
homeserver.yaml (TASK-198; baked as /inject-jwt-key.py, run by the
entrypoint between the render and the database preflight).

Fetches KEYCLOAK_FETCH_URL, reads the realm document's `public_key` (a
base64 SPKI string) and writes it into jwt_config.secret as a PEM block --
compose env vars cannot carry a multi-line PEM (newlines collapse, breaking
authlib's PEM framing parser). When no key is available, JWT login is
DISABLED so Synapse still boots (degrade-and-boot); /synapse-healthcheck.sh
reports that state as unhealthy.
"""

import json
import os
import sys
import textwrap
import urllib.error
import urllib.request


def fetch_pem(fetch_url):
    """The realm key as PEM, or None (with the reason on stderr)."""
    if not fetch_url:
        return None
    try:
        with urllib.request.urlopen(fetch_url, timeout=10) as r:
            realm_data = json.load(r)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        sys.stderr.write(f"[gremion-synapse] realm key fetch failed: {exc}\n")
        return None
    public_key = realm_data.get("public_key") if isinstance(realm_data, dict) else None
    if not public_key or not isinstance(public_key, str):
        sys.stderr.write("[gremion-synapse] realm response missing public_key field\n")
        return None
    pem_body = "\n".join(textwrap.wrap(public_key, 64))
    return f"-----BEGIN PUBLIC KEY-----\n{pem_body}\n-----END PUBLIC KEY-----\n"


def apply(cfg, pem):
    """Writes the key into cfg (in place) or disables JWT login."""
    jwt_cfg = cfg.setdefault("jwt_config", {})
    if pem:
        jwt_cfg["secret"] = pem
        sys.stderr.write("[gremion-synapse] Injected the realm public key into jwt_config.secret\n")
    else:
        # No key available — disable JWT login so Synapse still boots. The
        # secret key STAYS (empty): Synapse's JWTConfig reads
        # jwt_config["secret"] whenever the block exists, enabled or not, and
        # a missing key crash-loops it (measured on 1.160, scratch proof 7c).
        jwt_cfg["enabled"] = False
        jwt_cfg["secret"] = ""
        sys.stderr.write("[gremion-synapse] WARNING: jwt_config disabled — realm public key unavailable\n")
    return cfg


def main(argv):
    import yaml

    config_path = argv[1]
    with open(config_path) as f:
        cfg = yaml.safe_load(f)
    apply(cfg, fetch_pem(os.environ.get("KEYCLOAK_FETCH_URL", "").strip()))
    with open(config_path, "w") as f:
        yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)


if __name__ == "__main__":
    main(sys.argv)
