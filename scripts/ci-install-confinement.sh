#!/usr/bin/env bash
set -euo pipefail

# The hosted runner's mirror+file list can stall on its Azure mirror. Use
# direct official repositories for this installation only, retaining Ubuntu
# archive authentication and leaving the runner's system sources untouched.
if [[ ${EUID} -ne 0 ]]; then
  echo 'Run this CI setup script with sudo.' >&2
  exit 1
fi
source /etc/os-release
if [[ ${ID:-} != ubuntu || ${VERSION_ID:-} != 22.04 || $(dpkg --print-architecture) != amd64 ]]; then
  echo 'Confinement CI setup requires the Ubuntu 22.04 amd64 runner.' >&2
  exit 1
fi
test -r /usr/share/keyrings/ubuntu-archive-keyring.gpg

apt_workspace=$(mktemp -d /tmp/pkgxray-confinement-apt.XXXXXXXX)
trap 'rm -rf -- "$apt_workspace"' EXIT
mkdir "$apt_workspace/sourceparts" "$apt_workspace/lists"
chmod 755 "$apt_workspace" "$apt_workspace/sourceparts" "$apt_workspace/lists"
cat > "$apt_workspace/sources.list" <<'SOURCES'
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu jammy main
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu jammy-updates main
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://security.ubuntu.com/ubuntu jammy-security main
SOURCES
chmod 644 "$apt_workspace/sources.list"

# Fresh lists prevent an unsuccessful update from silently using stale runner
# indexes. Both operations use the same isolated sources and signed indexes.
apt_options=(
  -o "Dir::Etc::sourcelist=$apt_workspace/sources.list"
  -o "Dir::Etc::sourceparts=$apt_workspace/sourceparts"
  -o "Dir::State::lists=$apt_workspace/lists"
  -o APT::Update::Error-Mode=any
  -o Acquire::Retries=1
  -o Acquire::https::Timeout=20
  -o Acquire::AllowInsecureRepositories=false
  -o APT::Get::AllowUnauthenticated=false
)
timeout --signal=TERM --kill-after=10s 120s apt-get "${apt_options[@]}" update
DEBIAN_FRONTEND=noninteractive timeout --signal=TERM --kill-after=10s 120s apt-get "${apt_options[@]}" install -y bubblewrap iproute2
