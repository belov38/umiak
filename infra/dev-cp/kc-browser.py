#!/usr/bin/env python3
"""A minimal browser for the Keycloak pages of the dev stack. Dev only (e2e.sh).

    kc-browser.py device <verification_uri_complete> <username> <password file>
        Approves a device grant (umiak login) as the user.
    kc-browser.py get <url> <username> <password file> [--cacert <pem>]
        Opens the URL as a browser navigation (Accept: text/html), follows the
        redirects and signs in to Keycloak on the way (port SSO through
        oauth2-proxy). Prints the final status, URL, cookie names and body head.

Walks the pages a browser would see: the login form, an optional user code form
and the consent form that Keycloak shows for a device grant. Fails on a required action (a temporary password,
a missing profile field), because the e2e user must be complete. Trusts the
system store (Tailscale Serve has Let's Encrypt) plus --cacert (dev CA previews).
"""

import html.parser
import http.cookiejar
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


class Forms(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.forms = []
        self._cur = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "form":
            self._cur = {"action": a.get("action") or "", "inputs": []}
            self.forms.append(self._cur)
        elif tag in ("input", "button") and self._cur is not None and a.get("name"):
            self._cur["inputs"].append(
                (a.get("name"), a.get("value") or "", (a.get("type") or "").lower())
            )

    def handle_endtag(self, tag):
        if tag == "form":
            self._cur = None


class Browser:
    def __init__(self, cacert=None):
        ctx = ssl.create_default_context()
        if cacert:
            ctx.load_verify_locations(cafile=cacert)
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar),
            urllib.request.HTTPSHandler(context=ctx),
        )

    def fetch(self, url, data=None):
        body = None if data is None else urllib.parse.urlencode(data).encode()
        req = urllib.request.Request(url, data=body, headers={"Accept": "text/html"})
        try:
            with self.opener.open(req, timeout=30) as r:
                return r.status, r.geturl(), r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.geturl(), e.read().decode("utf-8", "replace")

    def login_walk(self, status, url, page, user, password, done):
        """Submits Keycloak forms until done(status, url, page) or no form is left."""
        for _ in range(8):
            if done(status, url, page):
                return status, url, page
            p = Forms()
            p.feed(page)
            if not p.forms:
                break
            form = p.forms[0]
            names = {n for n, _, _ in form["inputs"]}
            # The consent of a device grant (OAUTH_GRANT) is a required action too; others
            # (a temporary password, a missing profile field) need dev-users.sh.
            if "/login-actions/required-action" in url and "accept" not in names:
                raise SystemExit(f"required action at {url}: complete the user (dev-users.sh)")
            data = {n: v for n, v, t in form["inputs"] if t not in ("submit", "button")}
            if "password" in names:
                data["username"] = user
                data["password"] = password
            if "accept" in names:
                data["accept"] = "Yes"
            status, url, page = self.fetch(urllib.parse.urljoin(url, form["action"]), data)
        return status, url, page


def main():
    args = sys.argv[1:]
    cacert = None
    if "--cacert" in args:
        i = args.index("--cacert")
        cacert = args[i + 1]
        del args[i : i + 2]
    if len(args) != 4 or args[0] not in ("device", "get"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    mode, url, user = args[0], args[1], args[2]
    with open(args[3], encoding="utf-8") as f:
        password = f.read().strip()
    b = Browser(cacert)
    status, cur, page = b.fetch(url)
    if mode == "device":

        def done(_s, _u, p):
            low = p.lower()
            return "device login successful" in low or "device-login-success" in low

        status, cur, page = b.login_walk(status, cur, page, user, password, done)
        if done(status, cur, page):
            print("approved")
            return 0
        print(f"no success page; last page {cur}:\n{page[:2000]}", file=sys.stderr)
        return 1

    # Keycloak and oauth2-proxy share the Serve name and differ in the port.
    origin = urllib.parse.urlsplit(url).netloc
    host = urllib.parse.urlsplit(url).hostname

    def back(_s, u, _p):
        return urllib.parse.urlsplit(u).netloc == origin

    status, cur, page = b.login_walk(status, cur, page, user, password, back)
    cookies = sorted({c.name for c in b.jar if c.domain.lstrip(".") == host})
    print(f"status {status}")
    print(f"url {cur}")
    print(f"cookies {' '.join(cookies)}")
    print(page[:400])
    return 0 if status == 200 and back(status, cur, page) else 1


if __name__ == "__main__":
    sys.exit(main())
