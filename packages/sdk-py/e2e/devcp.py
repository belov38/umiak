"""Basic flow of sbx-sdk against a real stack (infra/dev-cp/e2e.sh).

Not a unit test: it creates a sandbox on Proxmox. Credentials come from the SDK
chain (SBX_API_KEY, SBX_ACCESS_TOKEN, or `sbx auth token --json` of the CLI
profile on PATH).

    cd packages/sdk-py && uv run --locked python e2e/devcp.py

Prints one "ok <step>" line per step; exits 1 on the first failure and deletes
the sandbox in any case.
"""

import sys

from sbx_sdk import Sbx


def check(cond: bool, what: str) -> None:
    if not cond:
        print(f"check failed: {what}", file=sys.stderr)
        raise SystemExit(1)
    print(f"ok {what}", flush=True)


def main() -> None:
    with Sbx() as sbx:
        sb = sbx.sandboxes.create(
            template="linux", env={"E2E_SDK": "py"}, labels={"e2e": "sdk-py"}, wait=True
        )
        print(f"sandbox {sb.slug} {sb.id}", flush=True)
        try:
            r = sb.exec(["sh", "-c", 'echo "$E2E_SDK"; echo err >&2; exit 3'])
            check(r.stdout == "py\n" and r.stderr == "err\n" and r.exit_code == 3, "exec")
            sb.files.write_text("sdk-py.txt", "hello from py\n")
            check(sb.files.read_text("sdk-py.txt") == "hello from py\n", "files")
            cmd = sb.start(["sh", "-c", "for i in 1 2 3; do echo n$i; sleep 1; done"])
            check(cmd.wait().exit_code == 0, "start and wait")
            port = sb.ports.host(3000, access="token")
            check("-3000." in port.url and isinstance(port.token, str), "port host")
        finally:
            sb.delete()
            print("ok delete", flush=True)


if __name__ == "__main__":
    main()
