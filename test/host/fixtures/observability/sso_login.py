#!/usr/bin/env python3
"""TASK-039 proof only: drive Grafana's generic-OAuth sign-in against Keycloak
the way a browser does, and report whether Grafana opened a session.

usage: sso_login.py <grafana base url> <username> <password> [<totp secret>]
                    [--get <grafana path>]...

Prints one JSON line: {"session": bool, "role": str|null, "stage": str,
"detail": str, "gets": {path: [status, body]}}. `stage` names where the
sign-in ended: "grafana" (a session), "otp-setup" (Keycloak asked to configure
a second factor), "keycloak-error" (credentials refused), "grafana-refused"
(Grafana answered the callback without a session). Standard library only;
no value of the password or the secret is ever printed.
"""
import hashlib
import hmac
import html
import http.cookiejar
import json
import re
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def totp(secret: str, period: int = 30, digits: int = 6) -> str:
    # Keycloak's HmacOTP keys the HMAC with the secret's own bytes.
    counter = int(time.time()) // period
    mac = hmac.new(secret.encode("utf-8"), struct.pack(">Q", counter), hashlib.sha1).digest()
    o = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[o:o + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def main(argv):
    gets = []
    args = []
    i = 0
    while i < len(argv):
        if argv[i] == "--get":
            gets.append(argv[i + 1])
            i += 2
            continue
        args.append(argv[i])
        i += 1
    base, user, password = args[0].rstrip("/"), args[1], args[2]
    secret = args[3] if len(args) > 3 and args[3] else None

    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect)

    def unsecure():
        # The scratch Keycloak speaks http on the loopback but marks its
        # session cookies Secure (SameSite=None); a browser treats
        # http://127.0.0.1 as a secure context and sends them, urllib does not.
        for c in jar:
            c.secure = False

    def req(url, data=None):
        body = urllib.parse.urlencode(data).encode() if data is not None else None
        r = urllib.request.Request(url, data=body, headers={"User-Agent": "obs-proof"})
        try:
            resp = opener.open(r, timeout=20)
            out = resp.status, resp.headers, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            out = e.code, e.headers, e.read().decode("utf-8", "replace")
        unsecure()
        return out

    out = {"session": False, "role": None, "stage": "start", "detail": "", "gets": {}}

    status, headers, _ = req(base + "/login/generic_oauth")
    url = headers.get("Location")
    if status not in (301, 302, 303) or not url:
        out.update(stage="grafana-no-redirect", detail=f"status {status}")
        return out
    # Follow redirects into Keycloak until a page with a form.
    page = ""
    for _ in range(10):
        status, headers, page = req(url)
        if status in (301, 302, 303):
            url = urllib.parse.urljoin(url, headers.get("Location"))
            continue
        break
    form = re.search(r'<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"', page)
    if not form:
        out.update(stage="keycloak-no-login-form", detail=f"status {status}")
        return out
    status, headers, page = req(html.unescape(form.group(1)), {"username": user, "password": password, "credentialId": ""})
    for step in range(4):
        if status in (301, 302, 303):
            url = headers.get("Location")
            break
        otp = re.search(r'<form[^>]*id="kc-otp-login-form"[^>]*action="([^"]+)"', page)
        if otp:
            if not secret:
                out.update(stage="otp-without-secret")
                return out
            status, headers, page = req(html.unescape(otp.group(1)), {"otp": totp(secret), "login": "Sign In"})
            continue
        if 'id="kc-totp-settings-form"' in page or "totp" in page.lower() and "configure" in page.lower():
            out.update(stage="otp-setup", detail="Keycloak requires a second factor this user does not have")
            return out
        err = re.search(r'id="input-error[^"]*"[^>]*>\s*([^<]+)', page) or re.search(r'class="[^"]*alert-error[^"]*"[\s\S]*?<span[^>]*>([^<]+)', page)
        out.update(stage="keycloak-error", detail=(err.group(1).strip() if err else f"status {status}"))
        return out
    if not url or not url.startswith(base):
        out.update(stage="keycloak-no-callback", detail=str(url)[:120])
        return out
    status, headers, _ = req(url)
    cookies = {c.name for c in jar}
    status_user, _, body = req(base + "/api/user")
    if status_user == 200:
        out["session"] = True
        out["stage"] = "grafana"
        s_orgs, _, orgs = req(base + "/api/user/orgs")
        try:
            out["role"] = json.loads(orgs)[0].get("role") if s_orgs == 200 else None
        except (ValueError, IndexError):
            out["role"] = None
        for path in gets:
            s, _, b = req(base + path)
            out["gets"][path] = [s, b[:4000]]
    else:
        out.update(stage="grafana-refused", detail=f"callback {status}, /api/user {status_user}, cookies {sorted(c for c in cookies if c.startswith('grafana'))}")
    return out


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1:])))
