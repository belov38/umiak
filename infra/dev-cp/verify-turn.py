"""Live TURN transport/peer-policy/expiry probe. No credentials are logged.

Wire format and MESSAGE-INTEGRITY follow RFC 8489 sections 14.5 and 14.8.
Uses the dev deployment's REST secret through SSH; never writes that secret.
"""
import base64
import hashlib
import hmac
import os
from pathlib import Path
import socket
import ssl
import struct
import subprocess
import time

COOKIE = 0x2112A442


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
    def __init__(self, transport, ip, host, ca, secret, ttl=120):
        self.transport = transport
        self.username = f"{int(time.time()) + ttl}:s10-verification".encode()
        self.password = base64.b64encode(hmac.digest(secret, self.username, "sha1"))
        self.key = None
        self.auth = []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM if transport == "udp" else socket.SOCK_STREAM)
        self.sock.settimeout(10)
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
        address = response[0x16]
        port = struct.unpack("!H", address[2:4])[0] ^ (COOKIE >> 16)
        assert 49160 <= port <= 49200, "relay escaped dev port range"

    def permission(self, ip):
        value = bytes([0, 1]) + struct.pack("!H", 50000 ^ (COOKIE >> 16))
        value += bytes(a ^ b for a, b in zip(socket.inet_aton(ip), struct.pack("!I", COOKIE)))
        return self.request(8, [(0x12, value)])[2]

    def refresh(self, lifetime):
        return self.request(4, [(0xD, struct.pack("!I", lifetime))])[2]

    def close(self):
        try:
            self.refresh(0)
        finally:
            self.sock.close()


def main():
    ip = os.environ.get("SBX_CP_IP", "192.168.68.90")
    host = os.environ.get("SBX_DEVCP_TURN_HOST", f"turn.tunnel.{ip.replace('.', '-')}.sslip.io")
    ca = os.environ.get("SBX_DEVCP_CA_DIR", str(Path.home() / ".config/sbx/dev-ca")) + "/ca.pem"
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
            print(f"ok TURN {transport}: allocate, restricted peers, refresh", flush=True)
        finally:
            turn.close()
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
