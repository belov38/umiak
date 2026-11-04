"""Terminal styling: step headers, action blocks, links.

Colors only on a TTY without NO_COLOR; emoji only when the terminal is also UTF-8 and
not the Linux text console (no emoji glyphs there). Otherwise plain ASCII markers.
"""

import os
import sys

# Step icons by the step's first word; single code points (no variation selector) so the width is stable.
ICONS = {
    "Checking": "🔍", "Questions": "📝", "The": "📋", "Preparing": "🧰", "Creating": "📦", "Connecting": "🔗",
    "Starting": "🚀", "Publishing": "🌐", "Downloading": "📥", "Updating": "🔄", "Fixed": "🔧", "Scoped": "🔧",
    "Stopping": "🛑", "Destroying": "🧹", "Removing": "🧹",
}


def enabled() -> bool:
    isatty = getattr(sys.stdout, "isatty", None)
    return bool(isatty and isatty()) and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"


def emoji() -> bool:
    if not enabled() or os.environ.get("TERM") == "linux":
        return False
    locale = os.environ.get("LC_ALL") or os.environ.get("LC_CTYPE") or os.environ.get("LANG") or ""
    encoding = (getattr(sys.stdout, "encoding", "") or "").lower().replace("-", "")
    return "utf8" in locale.lower().replace("-", "") and encoding == "utf8"


def _sgr(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if enabled() else text


def bold(text: str) -> str:
    return _sgr("1", text)


def dim(text: str) -> str:
    return _sgr("2", text)


def link(text: str) -> str:
    return _sgr("1;4", text)


def ok(text: str) -> str:
    return _sgr("1;32", ("✅ " if emoji() else "✓ ") + text)


def error(text: str) -> str:
    return _sgr("1;31", ("❌ " if emoji() else "") + text)


def step(text: str) -> str:
    if emoji():
        return ICONS.get(text.split(" ", 1)[0], "🔹") + " " + bold(text)
    return _sgr("1;36", "==>") + " " + bold(text)


def action(out, title: str, url: str | None = None, note: str | None = None) -> None:
    """Something the user must do now: after a blank line, the link on its own line."""
    out("")
    out(_sgr("1;33", ("👉 " if emoji() else "▶ ") + title))
    if url:
        out("  " + link(url))
    if note:
        out("  " + note)
