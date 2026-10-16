#!/usr/bin/env bash
# Install an NVIDIA CDI spec that Podman 4.x can read, so containers can use the GPU
# (used by the Kokoro TTS service). Run with sudo:  sudo scripts/nvidia-cdi-podman.sh
#
# Why: nvidia-container-toolkit >= 1.17 writes `additionalGids` (a CDI 0.7 field). Podman 4.x
# rejects the whole spec because of it ("unresolvable CDI devices nvidia.com/gpu=all").
# The field only adds the video/render groups for /dev/dri, which CUDA doesn't need.
# Re-run this after NVIDIA driver updates.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo." >&2
  exit 1
fi

tmp=$(mktemp --suffix=.yaml)  # nvidia-ctk appends .yaml to extensionless paths
trap 'rm -f "$tmp"' EXIT
nvidia-ctk cdi generate --quiet --output="$tmp"

python3 - "$tmp" <<'PY'
import re, sys
path = sys.argv[1]
out, skip_indent = [], None
for line in open(path):
    indent = len(line) - len(line.lstrip())
    if skip_indent is not None:
        if line.strip() and indent > skip_indent:
            continue  # list items under additionalGids
        skip_indent = None
    if line.strip() == "additionalGids:":
        skip_indent = indent
        continue
    out.append(line)
text = re.sub(r"^cdiVersion: .*$", "cdiVersion: 0.6.0", "".join(out), count=1, flags=re.M)
open(path, "w").write(text)
PY

if ! grep -q "^devices:" "$tmp"; then
  echo "Generated spec looks empty; not installing it." >&2
  exit 1
fi
install -m 644 "$tmp" /etc/cdi/nvidia.yaml
echo "✓ wrote /etc/cdi/nvidia.yaml (Podman-compatible)"

# The toolkit's refresh units regenerate /var/run/cdi/nvidia.yaml with the incompatible field
# (on boot and driver changes). Turn them off and remove that copy; re-run this script instead.
systemctl disable --now nvidia-cdi-refresh.path nvidia-cdi-refresh.service 2>/dev/null || true
rm -f /var/run/cdi/nvidia.yaml
echo "✓ disabled nvidia-cdi-refresh (re-run this script after driver updates)"

nvidia-ctk cdi list
