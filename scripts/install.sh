#!/usr/bin/env bash
set -euo pipefail

REPO_SSH="${OPENTIGER_REPO_SSH:-git@github.com:Andyyyy64/openTiger.git}"
TARGET_DIR="${OPENTIGER_DIR:-openTiger}"

if [[ -n "${1:-}" ]]; then
  TARGET_DIR="$1"
fi

require_command() {
  local cmd="$1"
  local message="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "$message" >&2
    exit 1
  fi
}

require_node_version() {
  local required_major="$1"
  local required_minor="$2"
  local raw_version
  raw_version="$(node -v 2>/dev/null || true)"
  if [[ ! "$raw_version" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "Unable to parse Node.js version: ${raw_version}" >&2
    exit 1
  fi

  local major="${BASH_REMATCH[1]}"
  local minor="${BASH_REMATCH[2]}"
  if (( major < required_major )) || (( major == required_major && minor < required_minor )); then
    echo "Node.js >=${required_major}.${required_minor} is required (current: ${raw_version})." >&2
    exit 1
  fi
}

check_gh_readiness() {
  if ! command -v gh >/dev/null 2>&1; then
    cat <<'EOF'

GitHub CLI (gh) was not found.
Install gh and run authentication before starting openTiger:
  https://github.com/cli/cli#installation
  gh auth login
EOF
    return
  fi

  if ! gh auth status -h github.com >/dev/null 2>&1; then
    cat <<'EOF'

GitHub CLI is installed but not authenticated.
Run authentication before starting openTiger:
  gh auth login
EOF
    return
  fi

  echo
  echo "GitHub CLI is ready. Nice!"
}

require_command "git" "git is required. Install git first."
require_command "node" "Node.js >=22.12 is required. Install Node.js first."
require_node_version 22 12
require_command "docker" "Docker is required. Install Docker first."

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    echo "pnpm not found. Enabling pnpm via corepack..."
    corepack enable
    corepack prepare pnpm@9.15.4 --activate
  else
    echo "pnpm is required and corepack was not found." >&2
    exit 1
  fi
fi

if [[ -e "$TARGET_DIR" ]]; then
  echo "Target directory '$TARGET_DIR' already exists. Remove it or set OPENTIGER_DIR." >&2
  exit 1
fi

echo "Cloning openTiger into $TARGET_DIR..."
git clone "$REPO_SSH" "$TARGET_DIR"
cd "$TARGET_DIR"

echo "Running setup..."
pnpm run setup

check_gh_readiness

cat <<EOF

openTiger setup is complete.
Next step:
  cd ${TARGET_DIR}
  pnpm run up

Dashboard: http://localhost:5190
API:       http://localhost:4301
EOF
