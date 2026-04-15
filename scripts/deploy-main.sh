#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Not a git repository: $REPO_ROOT"
  exit 1
fi

git add -A

if git diff --cached --quiet; then
  echo "No staged changes to commit."
  exit 0
fi

MESSAGE="${1:-Update $(date '+%Y-%m-%d %H:%M')}"
git commit -m "$MESSAGE"
git push origin main

echo "Pushed to main. Vercel will auto-deploy from Git."
