#!/usr/bin/env bash

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "Not inside a git repository; skip git hook installation."
  exit 0
fi

cd "$repo_root"

git config core.hooksPath .githooks
chmod +x .githooks/pre-push

echo "Git hooks installed: core.hooksPath=.githooks"
