#!/usr/bin/env bash
set -euo pipefail

sha="${1:-}"
repo="${GITHUB_REPOSITORY:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::release gate: expected a full commit sha, got '$sha'" >&2
  exit 2
fi
if [[ ! "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "::error::release gate: GITHUB_REPOSITORY is not owner/name: '$repo'" >&2
  exit 2
fi
if ! git rev-parse --verify --quiet origin/main >/dev/null; then
  echo "::error::release gate: origin/main is not fetched; check out with fetch-depth: 0" >&2
  exit 2
fi
if ! git merge-base --is-ancestor "$sha" origin/main; then
  echo "::error::release gate: $sha is not on main; only commits merged to main are published" >&2
  exit 1
fi
query="repos/$repo/actions/workflows/factory.yml/runs?head_sha=$sha&branch=main&event=push&status=success&per_page=1"
if ! runs=$(gh api "$query" --jq '.total_count'); then
  echo "::error::release gate: the Actions API did not answer for factory.yml runs of $sha" >&2
  exit 2
fi
if [[ ! "$runs" =~ ^[0-9]+$ ]]; then
  echo "::error::release gate: unreadable answer from the Actions API: '$runs'" >&2
  exit 2
fi
if (( runs < 1 )); then
  echo "::error::release gate: factory.yml has no successful run on main for $sha; publish waits for it" >&2
  exit 1
fi
echo "release gate: $sha is on main and passed factory.yml"
