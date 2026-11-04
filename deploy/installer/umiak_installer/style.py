"""Terminal styling: step headers, action blocks, links. Plain text when stdout is not a TTY or NO_COLOR is set."""

import os
import sys


def enabled() -> bool:
    isatty = getattr(sys.stdout, "isatty", None)
    return bool(isatty and isatty()) and not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb"


def _sgr(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if enabled() else text


def bold(text: str) -> str:
    return _sgr("1", text)


def dim(text: str) -> str:
    return _sgr("2", text)


def link(text: str) -> str:
    return _sgr("1;4", text)


def ok(text: str) -> str:
    return _sgr("1;32", text)


def error(text: str) -> str:
    return _sgr("1;31", text)


def step(text: str) -> str:
    return _sgr("1;36", "==>") + " " + bold(text)


def action(out, title: str, url: str | None = None, note: str | None = None) -> None:
    """Something the user must do now: after a blank line, the link on its own line."""
    out("")
    out(_sgr("1;33", "▶ " + title))
    if url:
        out("  " + link(url))
    if note:
        out("  " + note)
