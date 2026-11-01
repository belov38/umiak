"""Live TURN transport/peer-policy/expiry probe. No credentials are logged.

Wire format and MESSAGE-INTEGRITY follow RFC 8489 sections 14.5 and 14.8.
Uses the dev deployment's REST secret through SSH; never writes that secret.
"""
import base64
import hashlib
import hmac
import os
from pathlib import Path
import shlex
import socket
import ssl
import struct
import subprocess
import time

COOKIE = 0x2112A442
RELAY_MIN, RELAY_MAX = (int(p) for p in os.environ.get("SBX_TURN_PROBE_RELAY_RANGE", "61000-61040").split("-"))


def attr(kind, value):
    return struct.pack("!HH", kind, len(value)) + value + bytes((-len(value)) % 4)


def packet(kind, transaction, attrs, key=None):
    body = b"".join(attr(k, v) for k, v in attrs)
    header = struct.pack("!HHI12s", kind, len(body) + (24 if key else 0), COOKIE, transaction)
    if key:
        body += attr(8, hmac.digest(key, header + body, "sha1"))
    return header + body


def unpack(data):
    kind, length, cookie = struct.unpack("!HHI", data[:8])
    assert cookie == COOKIE and len(data) >= 20 + length
    attrs = {}
    offset = 20
    while offset < 20 + length:
        k, n = struct.unpack("!HH", data[offset:offset + 4])
        attrs[k] = data[offset + 4:offset + 4 + n]
        offset += 4 + n + (-n) % 4
    error = attrs.get(9)
    code = error[2] * 100 + error[3] if error else 0
    return kind, attrs, code


class Turn:
    def __init__(self, transport, ip, host, ca, secret, ttl=120, timeout=10):
        self.transport = transport
        self.timeout = timeout
        self.username = f"{int(time.time()) + ttl}:s10-verification".encode()
        self.password = base64.b64encode(hmac.digest(secret, self.username, "sha1"))
        self.key = None
        self.auth = []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM if transport == "udp" else socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sock.connect((ip, 5349 if transport == "tls" else 3478))
        if transport == "tls":
            self.sock = ssl.create_default_context(cafile=ca).wrap_socket(self.sock, server_hostname=host)

    def recv_n(self, count):
        result = b""
        while len(result) < count:
            chunk = self.sock.recv(count - len(result))
            if not chunk:
                raise RuntimeError("TURN connection closed")
            result += chunk
        return result

    def request(self, kind, attrs):
        transaction = os.urandom(12)
        self.sock.sendall(packet(kind, transaction, attrs + self.auth, self.key))
        if self.transport == "udp":
            data = self.sock.recv(65536)
        else:
            header = self.recv_n(20)
            data = header + self.recv_n(struct.unpack("!H", header[2:4])[0])
        assert data[8:20] == transaction, "unexpected STUN transaction"
        return unpack(data)

    def allocate(self):
        attrs = [(0x19, bytes([17, 0, 0, 0]))]
        _, challenge, code = self.request(3, attrs)
        assert code == 401, f"expected authentication challenge, got {code}"
        realm, nonce = challenge[0x14], challenge[0x15]
        self.auth = [(6, self.username), (0x14, realm), (0x15, nonce)]
        self.key = hashlib.md5(self.username + b":" + realm + b":" + self.password).digest()
        kind, response, code = self.request(3, attrs)
        assert kind == 0x103 and code == 0, f"allocate failed {code}"
        assert 0 < struct.unpack("!I", response[0xD])[0] <= 60, "unbounded stale allocation lifetime"
        address = response[0x16]
        port = struct.unpack("!H", address[2:4])[0] ^ (COOKIE >> 16)
        self.relay_port = port
        assert RELAY_MIN <= port <= RELAY_MAX, "relay escaped dev port range"

    def peer(self, ip, port=50000):
        value = bytes([0, 1]) + struct.pack("!H", port ^ (COOKIE >> 16))
        return value + bytes(a ^ b for a, b in zip(socket.inet_aton(ip), struct.pack("!I", COOKIE)))

    def send_indication(self, ip, port, payload):
        # Send indications carry no credentials (RFC 8656 section 11).
        self.sock.sendall(packet(0x16, os.urandom(12), [(0x12, self.peer(ip, port)), (0x13, payload)]))

    def data_indication(self, timeout=3):
        self.sock.settimeout(timeout)
        try:
            if self.transport == "udp":
                data = self.sock.recv(65536)
            else:
                header = self.recv_n(20)
                data = header + self.recv_n(struct.unpack("!H", header[2:4])[0])
        except (socket.timeout, TimeoutError):
            return None
        finally:
            self.sock.settimeout(self.timeout)
        kind, attrs, _ = unpack(data)
        return attrs.get(0x13) if kind == 0x17 else None

    def permission(self, ip):
        return self.request(8, [(0x12, self.peer(ip))])[2]

    def renew_channel_like_moonlight(self, ip):
        # rtc-turn 0.21.1 deletes its binding on 438, then allocates a new number.
        # Coturn correctly refuses changing a channel number for an existing peer.
        channel = 0x4000
        def bind():
            return self.request(9, [(0x12, self.peer(ip)), (0xC, struct.pack("!HH", channel, 0))])
        assert bind()[2] == 0, "initial ChannelBind failed"
        time.sleep(3)
        _, response, code = bind()
        if code == 438:
            self.auth = [(k, response[0x15] if k == 0x15 else v) for k, v in self.auth]
            channel += 1
            code = bind()[2]
        assert code == 0, f"moonlight ChannelBind renewal failed: {code}"

    def refresh(self, lifetime):
        return self.request(4, [(0xD, struct.pack("!I", lifetime))])[2]

    def close(self):
        try:
            self.refresh(0)
        finally:
            self.sock.close()


def listen_while(ssh, ip, ports, send):
    """UDP sockets of the CT host bound to ip:ports; returns 'nothing' or what arrived."""
    listener = subprocess.Popen(ssh + [shlex.join([
        "python3", "-I", "-c",
        "import select,socket,sys,time\n"
        "socks=[]\n"
        "for p in sys.argv[2:]:\n s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.bind((sys.argv[1],int(p))); socks.append(s)\n"
        "print('ready',flush=True)\n"
        "r,_,_=select.select(socks,[],[],6)\n"
        "print(' '.join(f'received {len(s.recvfrom(2048)[0])} on {s.getsockname()[1]}' for s in r) or 'nothing',flush=True)",
        ip, *map(str, ports),
    ])], stdout=subprocess.PIPE, text=True)
    try:
        assert listener.stdout.readline().strip() == "ready", "probe listener did not start"
        send()
        return listener.stdout.readline().strip()
    finally:
        listener.wait(timeout=20)


def relays(ip, host, ca, secret):
    """True when a UDP allocation reaches another allocation's relay (relay <-> relay)."""
    try:
        a, b = (Turn("udp", ip, host, ca, secret, timeout=1) for _ in range(2))
    except OSError:
        return False
    try:
        a.allocate()
        b.allocate()
        if a.permission(ip) or b.permission(ip):
            return False
        payload = os.urandom(16)
        for _ in range(3):
            a.send_indication(ip, b.relay_port, payload)
            if b.data_indication(timeout=1) == payload:
                return True
        return False
    except (OSError, AssertionError, RuntimeError, struct.error):
        return False
    finally:
        for t in (a, b):
            try:
                t.close()
            except (OSError, AssertionError, RuntimeError, struct.error):
                pass


def guard_probe(ssh, pve, ip, host, ca, secret):
    """Fail-closed relay table: removal stops relaying; nftables reload on the CT does not touch it."""
    table = ["docker", "exec", "sbx-turn-1", "nft", "-s", "list", "table", "inet", "sbx_turn"]
    assert relays(ip, host, ca, secret), "relay <-> relay broken before the guard probe"
    subprocess.check_call(ssh + ["docker", "exec", "sbx-turn-1", "nft", "delete", "table", "inet", "sbx_turn"])
    removed = time.monotonic()
    while True:
        attempt = time.monotonic()
        if not relays(ip, host, ca, secret):
            break
        assert attempt - removed < 10, "TURN kept relaying without its egress table"
    stopped = attempt - removed
    while not (relays(ip, host, ca, secret) and subprocess.run(ssh + table, capture_output=True).returncode == 0):
        assert time.monotonic() - removed < 90, "TURN did not recover with its table"
        time.sleep(1)
    print(f"ok TURN stopped relaying {stopped:.1f} s after its table was deleted, "
          f"recovered with the table after {time.monotonic() - removed:.1f} s", flush=True)
    before = subprocess.check_output(ssh + ["docker", "inspect", "-f", "{{.State.StartedAt}}", "sbx-turn-1"], text=True)
    subprocess.check_call(pve + ["pct", "exec", os.environ.get("SBX_DEVCP_CTID", "590"), "--",
                                 "systemctl", "reload", "nftables"])
    time.sleep(5)
    after = subprocess.check_output(ssh + ["docker", "inspect", "-f", "{{.State.StartedAt}}", "sbx-turn-1"], text=True)
    assert before == after, "nftables reload on the CT restarted TURN"
    assert subprocess.run(ssh + table, capture_output=True).returncode == 0, "nftables reload removed the TURN table"
    assert relays(ip, host, ca, secret), "TURN stopped relaying after nftables reload on the CT"
    print("ok nftables reload on the CT leaves the TURN namespace table and published ports", flush=True)


def main():
    ip = os.environ.get("SBX_CP_IP", "192.168.68.90")
    host = os.environ.get("SBX_DEVCP_TURN_HOST", f"turn.tunnel.{ip.replace('.', '-')}.sslip.io")
    ca = os.environ.get("SBX_DEVCP_CA_DIR", str(Path.home() / ".config/sbx/dev-ca")) + "/ca.pem"
    local_secret = os.environ.get("SBX_TURN_PROBE_SECRET_FILE")
    if local_secret:
        secret = Path(local_secret).read_bytes().strip()
    else:
        secret = subprocess.check_output([
            "ssh", "-o", "BatchMode=yes", os.environ.get("SBX_DEVCP_SSH", f"sbx@{ip}"),
            "cat", "boat-dev-clone/deploy/compose/secrets/turn/auth-secret",
        ]).strip()
    for transport in ("udp", "tcp", "tls"):
        turn = Turn(transport, ip, host, ca, secret)
        try:
            turn.allocate()
            for denied in ("8.8.8.8", "192.168.68.116", "10.77.0.2", "10.77.0.3"):
                assert turn.permission(denied) == 403, "TURN allowed a forbidden peer"
            assert turn.permission(ip) == 0, "TURN denied its own relay address"
            assert turn.refresh(60) == 0, "valid credential refresh failed"
            if transport == "udp" and os.environ.get("SBX_TURN_PROBE_CHANNEL_RENEWAL"):
                turn.renew_channel_like_moonlight(ip)
                print("ok moonlight-compatible ChannelBind renewal", flush=True)
            print(f"ok TURN {transport}: allocate, restricted peers, refresh", flush=True)
        finally:
            turn.close()
    ssh = ["ssh", "-o", "BatchMode=yes", os.environ.get("SBX_DEVCP_SSH", f"sbx@{ip}")]
    # Relay <-> relay: each client transport reaches a UDP relay of this server.
    sender = Turn("udp", ip, host, ca, secret)
    try:
        sender.allocate()
        assert sender.permission(ip) == 0, "TURN denied its own relay address"
        for transport in ("udp", "tcp", "tls"):
            receiver = Turn(transport, ip, host, ca, secret)
            try:
                receiver.allocate()
                assert receiver.permission(ip) == 0, "TURN denied its own relay address"
                payload = os.urandom(16)
                for _ in range(3):
                    sender.send_indication(ip, receiver.relay_port, payload)
                    if receiver.data_indication() == payload:
                        break
                else:
                    raise AssertionError(f"relay to relay over {transport} lost the media")
                print(f"ok TURN relay<->relay media to a {transport} client", flush=True)
            finally:
                receiver.close()
        # Sockets of the host on the TURN address, outside and inside the relay range
        # (another service, an ephemeral client socket), are never relay peers.
        listen = int(os.environ.get("SBX_TURN_PROBE_LISTEN_PORT", "40123"))
        result = listen_while(ssh, ip, [listen, RELAY_MAX - 1], lambda: [
            sender.send_indication(ip, port, b"s10-port-probe")
            for port in (listen, 41641, RELAY_MAX - 1) for _ in range(3)
        ])
        assert result == "nothing", f"TURN relayed to a host socket on {ip} ({result})"
        drops = subprocess.check_output(ssh + [
            "docker", "exec", "sbx-turn-1", "nft", "list", "chain", "inet", "sbx_turn", "relay_egress",
        ], text=True)
        assert "non-relay peer" in drops and "packets 0 " not in drops.split("non-relay peer")[0].splitlines()[-1], \
            "relay egress filter did not count the denied probe"
        print(f"ok TURN host sockets on {listen}, 41641 and relay-range {RELAY_MAX - 1} unreachable", flush=True)
    finally:
        sender.close()
    if os.environ.get("SBX_TURN_PROBE_GUARD"):
        guard_probe(ssh, ["ssh", "-o", "BatchMode=yes", os.environ.get("SBX_DEVCP_PVE_SSH", "pve")],
                    ip, host, ca, secret)
    if os.environ.get("SBX_TURN_PROBE_RECONNECTS"):
        clients = []
        try:
            for _ in range(6):
                client = Turn("udp", ip, host, ca, secret)
                clients.append(client)
                client.allocate()
            print("ok six overlapping TURN allocations for reconnect", flush=True)
        finally:
            for client in clients:
                client.close()
    expired = Turn("udp", ip, host, ca, secret, ttl=5)
    try:
        expired.allocate()
        time.sleep(7)
        code = expired.refresh(60)
        assert code in (401, 438), f"expired TURN REST credentials refreshed allocation: {code}"
        print("ok TURN expired credentials rejected on Refresh", flush=True)
    finally:
        expired.close()


if __name__ == "__main__":
    main()
