"""Download size and progress for image pulls.

`docker compose --progress json pull` reports per-layer bytes only once a layer
starts downloading (three at a time), so the total is read up front from the
registry manifest for linux/amd64. Both parts are best effort: without a size
the installer still shows bytes and speed, and a pull never fails because of them.
"""

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

LOOKUP_TIMEOUT_S = 10
REPORT_EVERY_S = 10.0
ACCEPT = ", ".join((
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
))
PLAIN_LINE = re.compile(r"([0-9a-f]{12}): (.+)")
DONE_TEXTS = frozenset({"Verifying Checksum", "Download complete", "Extracting", "Pull complete"})


def _reference(image: str) -> tuple[str, str, str]:
    name, tag = image, "latest"
    if "@" in name:
        name, tag = name.split("@", 1)
    elif ":" in name.rsplit("/", 1)[-1]:
        name, tag = name.rsplit(":", 1)
    first = name.split("/", 1)[0]
    if "/" in name and ("." in first or ":" in first or first == "localhost"):
        return first, name.split("/", 1)[1], tag
    return "registry-1.docker.io", name if "/" in name else "library/" + name, tag


def _get(url: str, token: str | None = None) -> dict:
    headers = {"Accept": ACCEPT}
    if token:
        headers["Authorization"] = "Bearer " + token
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=LOOKUP_TIMEOUT_S) as response:
        return json.load(response)


def _anonymous_token(challenge: str, repo: str) -> str | None:
    fields = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    if not fields.get("realm", "").startswith("https://"):
        return None
    query = urllib.parse.urlencode({"service": fields.get("service", ""), "scope": f"repository:{repo}:pull"})
    with urllib.request.urlopen(f"{fields['realm']}?{query}", timeout=LOOKUP_TIMEOUT_S) as response:
        body = json.load(response)
    return body.get("token") or body.get("access_token")


def layer_sizes(image: str) -> dict[str, int] | None:
    """Compressed linux/amd64 layer sizes keyed by the 12-character ID that pull progress uses."""
    try:
        host, repo, tag = _reference(image)
        url = f"https://{host}/v2/{repo}/manifests/"
        token = None
        try:
            manifest = _get(url + tag)
        except urllib.error.HTTPError as error:
            if error.code != 401:
                return None
            token = _anonymous_token(error.headers.get("WWW-Authenticate", ""), repo)
            manifest = _get(url + tag, token)
        if "manifests" in manifest:
            digest = next(m["digest"] for m in manifest["manifests"]
                          if m.get("platform", {}).get("os") == "linux"
                          and m.get("platform", {}).get("architecture") == "amd64")
            manifest = _get(url + digest, token)
        sizes = {layer["digest"].split(":", 1)[1][:12]: int(layer["size"]) for layer in manifest["layers"]}
        return sizes or None
    except Exception:  # noqa: BLE001 - sizes are optional; the pull itself reports real errors
        return None


def human_size(size: float) -> str:
    if size >= 1e9:
        return f"{size / 1e9:.1f} GB"
    return f"{size / 1e6:.0f} MB"


def human_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{max(1, round(seconds))} s"
    return f"{round(seconds / 60)} min"


class PullProgress:
    """Turns compose JSON progress lines into a status line every REPORT_EVERY_S seconds."""

    def __init__(self, sizes: dict[str, int] | None, say, clock=time.monotonic, every: float = REPORT_EVERY_S):
        self.sizes = sizes or {}
        self.say = say
        self.clock = clock
        self.every = every
        self.done: dict[str, int] = {}
        self.totals: dict[str, int] = {}
        self.cached: set[str] = set()  # layers already on disk are not downloaded
        self.started = clock()
        self.reported = self.started

    @property
    def total(self) -> int:
        return sum(size for layer, size in self.sizes.items() if layer not in self.cached)

    @property
    def downloaded(self) -> int:
        return sum(self.done.values())

    def feed(self, line: str) -> None:
        """Accept compose JSON events and plain `docker pull` lines (`<layer>: Download complete`)."""
        try:
            event = json.loads(line)
        except ValueError:
            plain = PLAIN_LINE.fullmatch(line.strip())
            if not plain:
                return
            event = {"id": plain[1], "parent_id": "plain", "text": plain[2]}
        if not isinstance(event, dict) or not event.get("parent_id") or not isinstance(event.get("id"), str):
            return
        layer = event["id"]
        if (self.sizes and layer not in self.sizes) or layer in self.cached:
            return  # config blobs, indexes and layers already on disk are not downloaded
        if event.get("text") == "Already exists":
            self.cached.add(layer)
            self.done.pop(layer, None)
            return
        if isinstance(event.get("total"), int):
            self.totals[layer] = event["total"]
        if event.get("text") == "Downloading" and isinstance(event.get("current"), int):
            self.done[layer] = event["current"]
        elif event.get("text") in DONE_TEXTS:
            self.done[layer] = self.sizes.get(layer) or self.totals.get(layer) or self.done.get(layer, 0)
        now = self.clock()
        if now - self.reported >= self.every:
            self.reported = now
            if self.downloaded or self.total:
                self.say(self.status(now))

    def status(self, now: float) -> str:
        done, total = self.downloaded, self.total
        rate = done / max(now - self.started, 1e-6)
        speed = f"{human_size(rate)}/s"
        if not total:
            return f"  {human_size(done)} downloaded · {speed}"
        left = max(total - done, 0)
        text = f"  {human_size(done)} of {human_size(total)} ({done * 100 // total}%) · {speed}"
        return text + (f" · about {human_duration(left / rate)} left" if rate > 0 and left else "")
