"""Add/remove only tagged dev TURN accepts; rollback preserves unrelated concurrent rules."""
from pathlib import Path
import sys

MARKER = "# s10-dev-turn"

def update(root: Path, enable: bool) -> None:
    cluster = root / "etc/pve/firewall/cluster.fw"
    ct = root / "etc/pve/firewall/590.fw"
    original_cluster, original_ct = cluster.read_text(), ct.read_text()
    for original in (original_cluster, original_ct):
        if not original.strip():
            raise ValueError("empty firewall config")
    cleaned = ["\n".join(line for line in text.split("\n") if MARKER not in line)
               for text in (original_cluster, original_ct)]
    if enable:
        if "[group sbx-egress]" not in cleaned[0] or "[RULES]" not in cleaned[1]:
            raise ValueError("expected firewall sections missing")
        anchor = "OUT DROP -dest +sbx-deny\n"
        if anchor not in cleaned[0]:
            raise ValueError("private egress guard missing")
        rules = f"OUT ACCEPT -dest +sbx-gateway -p udp -dport 3478 {MARKER}\n"
        cleaned[0] = cleaned[0].replace(anchor, rules + anchor, 1)
        rules = (f"IN ACCEPT -source 192.168.68.0/24 -p tcp -dport 3478,5349 {MARKER}\n"
                 f"IN ACCEPT -source 192.168.68.0/24 -p udp -dport 3478 {MARKER}\n")
        cleaned[1] = cleaned[1].replace("[RULES]\n", "[RULES]\n" + rules, 1)
    cluster.write_text(cleaned[0])
    ct.write_text(cleaned[1])

if __name__ == "__main__":
    update(Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/"), sys.argv[1] == "apply")
