#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

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
if timeout --signal=TERM --kill-after=10s 120s apt-get "${apt_options[@]}" update 2>&1 | tee "$apt_workspace/update.log"; then
  :
else
  update_status=$?
  # Retry only the observed DNS failure. Authentication, policy denials and
  # other failures must remain failures, including mixed DNS/auth failures.
  unexpected_errors=$(grep '^E:' "$apt_workspace/update.log" | grep -Ev "^E: Failed to fetch https://(archive|security)\\.ubuntu\\.com/[^ ]+ +Temporary failure resolving '(archive|security)\\.ubuntu\\.com'$|^E: Some index files failed to download\\. They have been ignored, or old ones used instead\\.$" || true)
  if [[ $update_status -ne 100 || -n $unexpected_errors ]] ||
      ! grep -q '^E: Failed to fetch .*Temporary failure resolving' "$apt_workspace/update.log" ||
      grep -Eiq 'denied|forbidden|unauthorized|policy' "$apt_workspace/update.log"; then
    exit "$update_status"
  fi
  # Ubuntu's python-apt-common mirror list identifies the kernel.org mirror
  # operator. Its current HTTPS endpoint is documented by mirrors.kernel.org.
  # Ubuntu signatures remain the authority; no mirror signing key is added.
  echo 'Primary Ubuntu DNS lookup failed; trying the kernel.org Ubuntu mirror.'
  sed -i -e 's|https://archive.ubuntu.com/ubuntu|https://mirrors.edge.kernel.org/ubuntu|g' \
    -e 's|https://security.ubuntu.com/ubuntu|https://mirrors.edge.kernel.org/ubuntu|g' "$apt_workspace/sources.list"
  rm -rf -- "$apt_workspace/lists"
  mkdir "$apt_workspace/lists"
  chmod 755 "$apt_workspace/lists"
  timeout --signal=TERM --kill-after=10s 120s apt-get "${apt_options[@]}" update
fi
DEBIAN_FRONTEND=noninteractive timeout --signal=TERM --kill-after=10s 120s apt-get "${apt_options[@]}" install -y bubblewrap iproute2
