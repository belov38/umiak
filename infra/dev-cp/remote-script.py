"""Run the deployment's stdin script without shell-embedded temporary-file cleanup."""
import os
import subprocess
import sys
import tempfile

with tempfile.NamedTemporaryFile(delete=False) as script:
    script.write(sys.stdin.buffer.read())
try:
    result = subprocess.run(["bash", script.name], stdin=subprocess.DEVNULL, check=False)
finally:
    os.unlink(script.name)
raise SystemExit(result.returncode)
