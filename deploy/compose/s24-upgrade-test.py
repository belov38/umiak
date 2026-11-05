"""Local S24 published-stack migration and released-bridge DB/state rollback test.

Run through mise. Requires Docker, pulled AMD64 source product images,
postgres:18.6-alpine, a locally built target image, and a helper image:
  docker build -t umiak-s24-backup-helper -f - . <<'EOF'
  FROM docker:29-cli
  RUN apk add --no-cache python3
  EOF

No Proxmox commands execute. The Docker backend replaces only host transport,
fencing/checkpoint storage; released bridge transaction/backup code is unchanged.
Credentials remain in memory and a private temporary fixture directory. Do not
publish its contents or Docker quickstart logs. Pass that directory to the
web's test/s24-browser.mjs for browser acceptance after the successful upgrade.
"""

import argparse
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = "0.4.0-edge.20261105.6"
BRIDGE = "ecacd544"
TARGET = "umiak-s24:acceptance"


def run(args, **kw):
    r = subprocess.run(args, check=False, capture_output=True, **kw)
    if r.returncode:
        raise RuntimeError(
            f"{args[:3]} failed ({r.returncode}): " + r.stderr.decode()[-1500:]
        )
    return r.stdout


def sql(query):
    return (
        run(
            compose
            + [
                "exec",
                "-T",
                "postgres",
                "psql",
                "-U",
                "umiak",
                "-d",
                "umiak",
                "-At",
                "-v",
                "ON_ERROR_STOP=1",
            ],
            input=query.encode(),
        )
        .decode()
        .strip()
    )


def request(path, body=None, cookie=None, key=None):
    headers = {"Origin": base}
    if cookie:
        headers["Cookie"] = cookie
    if key:
        headers["Authorization"] = "Bearer " + key
    if body is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
        return (
            r.status,
            dict(r.headers),
            json.loads(data)
            if "json" in r.headers.get("content-type", "")
            else data.decode(),
        )


def key_request():
    data = json.loads((work / "key.json").read_text())
    data["host"] = base.removeprefix("http://")
    script = "const http=require('http'),fs=require('fs');const k=JSON.parse(fs.readFileSync(0,'utf8'));http.get({host:'127.0.0.1',port:8080,path:'/v1/sandboxes',headers:{host:k.host,authorization:'Bearer '+k.secret}},r=>{let s='';r.on('data',b=>s+=b);r.on('end',()=>{if(r.statusCode!==200)throw new Error('Imported key rejected '+r.statusCode);process.stdout.write(s)})})"
    return json.loads(
        run(
            compose + ["exec", "-T", "api", "node", "-e", script],
            input=json.dumps(data).encode(),
        )
    )


def ready():
    config = json.loads((work / "compose.yaml").read_text())
    one_shots = {
        name
        for service in config["services"].values()
        for name, dep in service.get("depends_on", {}).items()
        if dep.get("condition") == "service_completed_successfully"
    }
    expected = set(config["services"]) - one_shots
    last_error = "pending"
    for _ in range(180):
        raw = run(compose + ["ps", "--format", "json"]).decode().strip()
        try:
            states = json.loads(raw or "[]")
        except json.JSONDecodeError:
            states = [json.loads(line) for line in raw.splitlines()]
        if isinstance(states, dict):
            states = [states]
        running = {
            s["Service"]
            for s in states
            if s.get("State") == "running"
            and s.get("Health") not in ("starting", "unhealthy")
        }
        if running >= expected:
            try:
                if request("/v1/meta")[0] == 200:
                    return
            except OSError as error:
                last_error = type(error).__name__
        time.sleep(1)
    raise RuntimeError("Stack health timed out: " + last_error)


tables = [
    "users",
    "teams",
    "memberships",
    "api_keys",
    "ssh_keys",
    "templates",
    "sizes",
    "platform_defaults",
]


def snapshot(schema):
    return {
        t: json.loads(
            sql(
                f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM {schema}.{t} t"
            )
        )
        for t in tables
    }


def source_auth():
    ready()
    logs = run(compose + ["logs", "--no-log-prefix", "quickstart"]).decode()
    m = re.search(r"Umiak one-time setup code: (\S+)", logs)
    assert m, "No source claim code"
    _, headers, _ = request("/owner/claim", {"code": m[1]})
    cookie = next(v for k, v in headers.items() if k.lower() == "set-cookie").split(
        ";"
    )[0]
    (work / "cookie").write_text(cookie)
    os.chmod(work / "cookie", 0o600)
    me = request("/api/v1/me", cookie=cookie)[2]
    (work / "me.json").write_text(json.dumps(me))
    key = request(
        "/api/v1/api-keys",
        {"name": "S24 pre-upgrade scoped key", "scopes": ["sandboxes:read"]},
        cookie=cookie,
    )[2]
    (work / "key.json").write_text(json.dumps(key))
    os.chmod(work / "key.json", 0o600)
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(work / "ssh")])
    ssh = request(
        "/api/v1/ssh-keys",
        {"name": "S24 source key", "publicKey": (work / "ssh.pub").read_text().strip()},
        cookie=cookie,
    )[2]
    (work / "ssh.json").write_text(json.dumps(ssh))
    pair = request("/owner/pair", {})[2]
    request(
        "/owner/pair/approve", {"id": pair["id"], "code": pair["code"]}, cookie=cookie
    )
    token = request("/owner/pair/poll", {"id": pair["id"], "secret": pair["secret"]})[
        2
    ]["token"]
    (work / "paired").write_text(token)
    os.chmod(work / "paired", 0o600)
    sql("""INSERT INTO payload.sizes(id,slug,vcpu,memory_mb,sort_order) VALUES(uuidv7(),'s24-custom',3,3072,17) ON CONFLICT(slug) DO NOTHING;
UPDATE payload.templates SET description='S24 operator edit',allowed_sizes='["2gb","s24-custom"]'::jsonb,sort_order=23 WHERE slug='linux';
UPDATE payload.platform_defaults SET stopped_retention_days=NULL,ttl_seconds=NULL,rate_limits_burst=NULL,default_quota_max_ram_mb=16384;
INSERT INTO payload.api_keys(id,name,team_id,secret_hash,prefix,last4,scopes,revoked_at,created_via,expires_at) VALUES(uuidv7(),'Nullable revoked audit',NULL,repeat('a',64),'umiak_a','aaaa','["sandboxes:read"]',now(),'api',now()+interval '1 day');""")
    (work / "expected.json").write_text(json.dumps(snapshot("payload")))
    print(
        "Populated source: owner, paired CLI, scoped key, SSH key, nullable audit, edited template, custom size/defaults",
        flush=True,
    )


def prepare_target():
    env = os.environ | {"UMIAK_VERSION": "0.4.0-edge.20261105.99"}
    target = json.loads(
        run(
            [
                "docker",
                "compose",
                "-p",
                project,
                "--project-directory",
                str(ROOT),
                "config",
                "--format",
                "json",
            ],
            env=env,
        )
    )
    source = json.loads((work / "source.json").read_text())
    for name, service in target["services"].items():
        if service["image"].startswith("ghcr.io/"):
            service["image"] = TARGET
        if name in source["services"] and "ports" in service:
            service["ports"] = source["services"][name]["ports"]
        for key in [
            "UMIAK_APP_ORIGIN",
            "UMIAK_APP_URL",
            "UMIAK_API_URL",
            "UMIAK_API_PUBLIC_URL",
            "UMIAK_PUBLIC_URL",
        ]:
            if key in service.get("environment", {}):
                service["environment"][key] = base
        for mount in service.get("volumes", []):
            if mount["type"] == "bind":
                mount["source"] = mount["source"].replace(str(ROOT), str(work))
    (work / "target.json").write_text(
        json.dumps(target).replace("172.29.116", "172.30.124")
    )
    bridge = work / "bridge"
    bridge.mkdir(exist_ok=True)
    files = (
        run(
            [
                "git",
                "ls-tree",
                "-r",
                "--name-only",
                BRIDGE,
                "deploy/installer/umiak_installer",
            ]
        )
        .decode()
        .splitlines()
    )
    for file in files:
        p = bridge / pathlib.Path(file).relative_to("deploy/installer")
        p.parent.mkdir(exist_ok=True, parents=True)
        p.write_bytes(run(["git", "show", "ecacd544:" + file]))
    (bridge / "VERSION").write_text("0.4.0-edge.20261105.5")
    (work / "bridge-helper.py").write_text(
        """import sys,json,subprocess\nfrom pathlib import Path\nsys.path.insert(0,"/work/umiak/bridge")\nfrom umiak_installer import backup\nbackup.CONFIG=Path("/work/umiak")\nbackup.BASE=Path("/backups")\nproject=sys.argv[1]\nbackup.COMPOSE=["docker","compose","-p",project,"--project-directory",str(backup.CONFIG)]\noriginal=backup.volume_path\ndef volume(name):\n path=Path(subprocess.check_output(["docker","volume","inspect",project+"_"+name,"--format","{{.Mountpoint}}"],text=True).strip())\n assert path.is_dir()\n return path\nbackup.volume_path=volume\nrequest=json.load(sys.stdin)\nif request["op"]=="backup":result=backup.backup(request["id"],request["release"])\nelif request["op"]=="restore":result=backup.restore(request["id"],True)\nelse:raise ValueError("Unknown request")\nprint(json.dumps(result))\n"""
    )
    print(
        "Target compose prepared; released bridge modules exported unchanged",
        flush=True,
    )


def helper(op, identity):
    payload = {"op": op, "id": identity, "release": SOURCE}
    cmd = [
        "docker",
        "run",
        "--rm",
        "--network",
        "host",
        "-i",
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        "/var/lib/docker/volumes:/var/lib/docker/volumes",
        "-v",
        str(work) + ":/work/umiak",
        "-v",
        project + "_backups:/backups",
        "umiak-s24-backup-helper",
        "python3",
        "/work/umiak/bridge-helper.py",
        project,
    ]
    result = run(cmd, input=json.dumps(payload).encode())
    return json.loads(result)


def assert_source():
    ready()
    assert sql("SELECT count(*) FROM pg_namespace WHERE nspname='payload'") == "1"
    assert (
        sql(
            "SELECT count(*) FROM information_schema.tables WHERE table_schema='runtime' AND table_name='users'"
        )
        == "0"
    )
    actual = snapshot("payload")
    expected = json.loads((work / "expected.json").read_text())
    # Source sessions/keys update audit fields on real requests; verify before auth.
    for t in tables:
        assert actual[t] == expected[t], f"Restored source differs: {t}"
    assert sql("SELECT to_regclass('runtime.s24_rollback_probe') IS NULL") == "t"
    cookie = (work / "cookie").read_text()
    request("/api/v1/me", cookie=cookie)
    key_request()
    request("/api/v1/me", key=(work / "paired").read_text())
    run(
        [
            "docker",
            "run",
            "--rm",
            "-v",
            project + "_pve-secrets:/state",
            "umiak-s24-backup-helper",
            "test",
            "!",
            "-e",
            "/state/s24-rollback-probe",
        ]
    )
    print(
        "Source restored: source DB rows, browser/CLI sessions and scoped key usable; target-only DB/state markers absent",
        flush=True,
    )


def assert_target():
    ready()
    actual = snapshot("runtime")
    expected = json.loads((work / "expected.json").read_text())
    for t in tables:
        want = expected[t]
        if t == "templates":
            want = [r for r in want if r["slug"] != "debian"]
        if t == "platform_defaults":
            want = [dict(r) for r in want]
            for r in want:
                if r["default_template"] == "debian":
                    r["default_template"] = "linux"
        assert actual[t] == want, f"Imported fields differ: {t}"
    cookie = (work / "cookie").read_text()
    me = request("/api/v1/settings/session", cookie=cookie)[2]
    assert me["user"]["id"] == json.loads((work / "me.json").read_text())["user"]["id"]
    paired = request("/api/v1/settings/session", key=(work / "paired").read_text())[2]
    assert paired["user"]["id"] == me["user"]["id"]
    key_request()
    ssh = request("/api/v1/ssh-keys", cookie=cookie)[2]
    assert (
        ssh["data"][0]["fingerprint"]
        == json.loads((work / "ssh.json").read_text())["fingerprint"]
    )
    templates = request("/api/v1/settings/templates", cookie=cookie)[2]
    assert (
        next(t for t in templates if t["slug"] == "linux")["description"]
        == "S24 operator edit"
    )
    for path in ["/app", "/app/settings/templates", "/app/settings/platform-defaults"]:
        assert '<div id="root">' in request(path, cookie=cookie)[2]
    print(
        "Target import exact across eight tables; source browser/paired CLI/scoped key/SSH and SPA deep links passed",
        flush=True,
    )


def exercise(forced):
    sys.path.insert(0, str(work / "bridge"))
    from umiak_installer.updater import transaction

    class DockerBackend:
        compatible = False

        def fence(self):
            pass  # Proxmox transport/fence is exercised by installer tests and owner live acceptance.

        def unfence(self):
            pass

        def checkpoint(self, value):
            (work / "checkpoint.json").write_text(json.dumps(value))

        def history(self, value):
            with (work / "history.jsonl").open("a") as f:
                f.write(json.dumps(value) + "\n")

        def retain(self):
            pass

        def backup(self):
            self.identity = time.strftime("%Y%m%d%H%M%S") + "-" + os.urandom(6).hex()
            helper("backup", self.identity)
            return self.identity

        def apply(self):
            (work / "compose.yaml").write_bytes((work / "target.json").read_bytes())
            (work / "deploy/compose/quickstart/run.mjs").write_bytes(
                (ROOT / "deploy/compose/quickstart/run.mjs").read_bytes()
            )
            run(compose + ["up", "-d", "--remove-orphans"])
            assert_target()
            if forced:
                sql(
                    "CREATE TABLE runtime.s24_rollback_probe(id int); INSERT INTO runtime.s24_rollback_probe VALUES(1)"
                )
                run(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "-v",
                        project + "_pve-secrets:/state",
                        "umiak-s24-backup-helper",
                        "touch",
                        "/state/s24-rollback-probe",
                    ]
                )
                raise RuntimeError("Forced target health failure")

        def rollback(self, backup, restore_data):
            assert restore_data is True
            helper("restore", backup)
            assert_source()

    result = transaction(DockerBackend())
    assert result["status"] == ("rolled_back" if forced else "updated"), result
    print(
        "Released bridge transaction:",
        result["status"],
        "restoreData=" + str(result["dataLoss"]),
        flush=True,
    )


def prepare():
    root = pathlib.Path(tempfile.mkdtemp(prefix="umiak-s24-upgrade-"))
    os.chmod(root, 0o700)
    project = "s24upgrade" + str(os.getpid())
    for rel in [
        "compose.yaml",
        "deploy/compose/quickstart/run.mjs",
        "deploy/compose/config/identity.yaml",
    ]:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(run(["git", "show", "v" + SOURCE + ":" + rel]))
    env = os.environ | {"UMIAK_VERSION": SOURCE}
    source = json.loads(
        run(
            [
                "docker",
                "compose",
                "-p",
                project,
                "--project-directory",
                str(root),
                "config",
                "--format",
                "json",
            ],
            env=env,
        )
    )

    def free():
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    port = free()
    for name, service in source["services"].items():
        if service["image"].startswith("ghcr.io/"):
            service["platform"] = "linux/amd64"
        for p in service.get("ports", []):
            p["host_ip"] = "127.0.0.1"
            p["published"] = str(
                port if name == "quickstart" and p["target"] == 4180 else free()
            )
        for key in [
            "UMIAK_APP_ORIGIN",
            "UMIAK_APP_URL",
            "UMIAK_API_URL",
            "UMIAK_API_PUBLIC_URL",
            "UMIAK_PUBLIC_URL",
        ]:
            if key in service.get("environment", {}):
                service["environment"][key] = f"http://localhost:{port}"
    text = json.dumps(source).replace("172.29.116", "172.30.124")
    source = json.loads(text)
    (root / "source.json").write_text(text)
    (root / "compose.yaml").write_text(text)
    (root / "acceptance.json").write_text(
        json.dumps({"project": project, "port": port, "root": str(root)})
    )
    print("Source project prepared:", root, flush=True)
    with (root / "compose-start.log").open("w") as log:
        subprocess.run(
            [
                "docker",
                "compose",
                "-p",
                project,
                "--project-directory",
                str(root),
                "up",
                "-d",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=log,
        )
    print("Source started", flush=True)
    return root


def configure(root):
    global work, info, project, base, compose
    work = root
    info = json.loads((work / "acceptance.json").read_text())
    project = info["project"]
    base = "http://localhost:" + str(info["port"])
    compose = ["docker", "compose", "-p", project, "--project-directory", str(work)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", type=pathlib.Path)
    parser.add_argument(
        "--phase",
        choices=["all", "prepare", "populate", "rollback", "upgrade", "verify"],
        default="all",
    )
    args = parser.parse_args()
    root = args.workdir or prepare()
    configure(root)
    if args.phase in ["all", "populate"]:
        source_auth()
    if args.phase in ["all", "rollback"]:
        prepare_target()
        exercise(True)
    if args.phase in ["all", "upgrade"]:
        (work / "expected.json").write_text(json.dumps(snapshot("payload")))
        prepare_target()
        exercise(False)
    if args.phase == "verify":
        assert_target()
    print("Private acceptance fixture:", root, flush=True)


if __name__ == "__main__":
    main()
