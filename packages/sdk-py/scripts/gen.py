"""Generates the committed code of umiak-sdk:

1. ``umiak_sdk/_gen``: openapi-python-client over ``apps/api/openapi/v1.json``
   (config ``openapi-python-client.yaml``, ``literal_enums: false``).
   The generator makes every enum a strict ``StrEnum``: an unknown value
   raises ``ValueError`` in ``from_dict``. The API marks the response enums
   that may grow with ``x-extensible-enum: true`` (S7 §5.9), so after
   generation every enum class whose value set equals the value set of such
   a schema gets a ``_missing_`` hook: an unknown value becomes a pseudo
   member (``value`` is the string, ``name`` is ``UNKNOWN``) instead of an
   error. Closed enums (frame ``type`` discriminators, request-only enums)
   stay strict.
2. ``umiak_sdk/_sync``: the blocking facade, rewritten from ``umiak_sdk/_async``
   by token replacement (async def -> def, await dropped, AsyncX -> X, ...),
   except the hand-written ``_io.py`` of each side.

Both outputs are formatted with ruff using this package's settings.

    uv run python scripts/gen.py            # regenerate in place
    uv run python scripts/gen.py --check    # exit 1 if the committed code is stale
"""

from __future__ import annotations

import argparse
import filecmp
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = ROOT.parent.parent
SPEC = REPO / "apps" / "api" / "openapi" / "v1.json"
CONFIG = ROOT / "openapi-python-client.yaml"
PYPROJECT = ROOT / "pyproject.toml"
PKG = ROOT / "umiak_sdk"
# Hand-written on both sides: the I/O primitives that differ (sleep, locks, subprocess).
SYNC_KEEP = {"_io.py"}

OPEN_ENUM_HOOK = """
    @classmethod
    def _missing_(cls, value: object) -> "{name} | None":
        # x-extensible-enum: a value this SDK does not know yet is kept as is.
        if not isinstance(value, str):
            return None
        member = str.__new__(cls, value)
        member._name_ = "UNKNOWN"
        member._value_ = value
        return member
"""


def extensible_value_sets(spec: dict) -> set[frozenset[str]]:
    found: set[frozenset[str]] = set()

    def walk(o: object) -> None:
        if isinstance(o, dict):
            if o.get("x-extensible-enum") is True and isinstance(o.get("enum"), list):
                # A nullable enum lists null; the generated class has the strings only.
                found.add(frozenset(str(v) for v in o["enum"] if v is not None))
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(spec)
    return found


ENUM_CLASS = re.compile(r"^class (\w+)\(StrEnum\):\n((?:    .*\n|\n)*)", re.M)
ENUM_VALUE = re.compile(r'^    \w+ = "((?:[^"\\]|\\.)*)"$', re.M)


def open_enums(models: Path, sets: set[frozenset[str]]) -> list[str]:
    """Adds the _missing_ hook to the extensible enum classes; returns their names."""
    opened: list[str] = []
    for f in sorted(models.glob("*.py")):
        text = f.read_text()
        m = ENUM_CLASS.search(text)
        if m is None:
            continue
        values = frozenset(json.loads(f'"{v}"') for v in ENUM_VALUE.findall(m.group(2)))
        if values not in sets:
            continue
        name = m.group(1)
        f.write_text(text.rstrip("\n") + "\n" + OPEN_ENUM_HOOK.format(name=name))
        opened.append(name)
    return opened


def ruff(*args: str) -> None:
    subprocess.run(
        [sys.executable, "-m", "ruff", *args, "--config", str(PYPROJECT)],
        check=True,
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
    )


def generate_client(out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "_gen"
        r = subprocess.run(
            [
                sys.executable,
                "-m",
                "openapi_python_client",
                "generate",
                "--path",
                str(SPEC),
                "--config",
                str(CONFIG),
                "--output-path",
                str(target),
                "--meta",
                "none",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            raise SystemExit(f"gen.py: openapi-python-client failed:\n{r.stdout}\n{r.stderr}")
        opened = open_enums(target / "models", extensible_value_sets(json.loads(SPEC.read_text())))
        if not opened:
            raise SystemExit("gen.py: no extensible enum found; did the generator change?")
        ruff("check", "--fix-only", "--select", "I,F401", "--quiet", str(target))
        ruff("format", "--quiet", str(target))
        if out.exists():
            shutil.rmtree(out)
        shutil.copytree(target, out)


# Order matters: longer names first.
SYNC_NAMES = [
    ("AsyncByteStream", "SyncByteStream"),
    ("handle_async_request", "handle_request"),
    ("set_async_httpx_client", "set_httpx_client"),
    ("asynccontextmanager", "contextmanager"),
    ("AbstractAsyncContextManager", "AbstractContextManager"),
    ("StopAsyncIteration", "StopIteration"),
    ("__aenter__", "__enter__"),
    ("__aexit__", "__exit__"),
    ("__aiter__", "__iter__"),
    ("__anext__", "__next__"),
    ("aiter_bytes", "iter_bytes"),
    ("aiter_raw", "iter_raw"),
    ("aread", "read"),
    ("aclose", "close"),
    ("aclosing", "closing"),
]
SYNC_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\(asyncio\)"), "(blocking)"),
    (re.compile(r"\basyncio facade\b"), "blocking facade"),
    # The generated endpoint functions: asyncio/asyncio_detailed -> sync/sync_detailed.
    (re.compile(r"\basyncio httpx client\b"), "blocking httpx client"),
    (re.compile(r"\.asyncio\("), ".sync("),
    (re.compile(r"``asyncio\*``"), "``sync*``"),
    (re.compile(r"\basync def\b"), "def"),
    (re.compile(r"\basync for\b"), "for"),
    (re.compile(r"\basync with\b"), "with"),
    (re.compile(r"\bawait "), ""),
    (re.compile(r"\banext\("), "next("),
    (re.compile(r"\baiter\("), "iter("),
    (re.compile(r"\b_async\b"), "_sync"),
    *[(re.compile(rf"\b{re.escape(a)}\b"), b) for a, b in SYNC_NAMES],
    # AsyncUmiak -> Umiak, AsyncClient -> Client, AsyncIterator -> Iterator, ...
    (re.compile(r"\bAsync([A-Z]\w*)"), r"\1"),
]


def to_sync(source: str, name: str) -> str:
    for pattern, repl in SYNC_RULES:
        source = pattern.sub(repl, source)
    header = f"# Generated from umiak_sdk/_async/{name} by scripts/gen.py; do not edit.\n"
    return header + source


def generate_sync(src: Path, out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp) / "_sync"
        target.mkdir()
        for f in sorted(src.glob("*.py")):
            if f.name in SYNC_KEEP:
                continue
            (target / f.name).write_text(to_sync(f.read_text(), f.name))
        ruff("check", "--fix-only", "--select", "I,F401", "--quiet", str(target))
        ruff("format", "--quiet", str(target))
        for f in out.glob("*.py"):
            if f.name not in SYNC_KEEP:
                f.unlink()
        for f in sorted(target.glob("*.py")):
            shutil.copy(f, out / f.name)


def _files(root: Path) -> set[Path]:
    """Every file under root (py.typed included), without bytecode caches."""
    return {
        p.relative_to(root) for p in root.rglob("*") if p.is_file() and "__pycache__" not in p.parts
    }


def same_tree(a: Path, b: Path) -> list[str]:
    """Relative paths of the files that differ between a and b."""
    names = _files(a) | _files(b)
    return sorted(
        str(n)
        for n in names
        if not (a / n).exists()
        or not (b / n).exists()
        or not filecmp.cmp(a / n, b / n, shallow=False)
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="compare instead of writing")
    args = ap.parse_args()
    if not args.check:
        generate_client(PKG / "_gen")
        generate_sync(PKG / "_async", PKG / "_sync")
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        gen = Path(tmp) / "_gen"
        generate_client(gen)
        sync = Path(tmp) / "_sync"
        shutil.copytree(PKG / "_sync", sync, ignore=shutil.ignore_patterns("__pycache__"))
        generate_sync(PKG / "_async", sync)
        stale = [f"_gen/{n}" for n in same_tree(gen, PKG / "_gen")]
        stale += [f"_sync/{n}" for n in same_tree(sync, PKG / "_sync")]
    if stale:
        print("stale generated files (run scripts/gen.py):", *stale, sep="\n  ")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
