#!/usr/bin/env bash
#
# install-skill.sh — symlink the agent-flow-dispatch skill into AI-tool skill dirs.
#
# The skill has a single canonical source of truth at <repo>/skills/agent-flow-dispatch.
# This script fans it out as symlinks into each tool's user-level skills directory,
# mirroring the machine's existing convention (~/.agents/skills/* is symlinked from
# ~/.workbuddy/skills, ~/.trae-cn/skills, ~/.claude/skills, ...).
#
# Why only two dispatcher front-ends for now (WorkBuddy + Trae SOLO CN):
# the actual workers are claude / opencode, so we cap the *host* tool set here and
# do NOT recurse over an open-ended list. Add more by passing dirs on the CLI or via
# AGENT_FLOW_SKILL_TARGETS.
#
# Usage:
#   ./install-skill.sh                         # default: WorkBuddy + Trae
#   ./install-skill.sh /path/a/skills /path/b  # explicit targets (overrides default)
#   AGENT_FLOW_SKILL_TARGETS="~/.x/skills:~/.y" ./install-skill.sh   # env override
#
set -euo pipefail

# Resolve repo root from this script: <repo>/scripts/install-skill.sh -> <repo>
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKILL_NAME="agent-flow-dispatch"
CANONICAL="$REPO_ROOT/skills/$SKILL_NAME"

if [ ! -f "$CANONICAL/SKILL.md" ]; then
  echo "ERROR: canonical skill not found at $CANONICAL/SKILL.md" >&2
  exit 1
fi

# Default host tool skill dirs (user-level). Workers are claude/opencode, so we
# support these two dispatcher front-ends for now.
DEFAULT_TARGETS=(
  "$HOME/.workbuddy/skills"
  "$HOME/.trae-cn/skills"
)

# Targets: CLI args > AGENT_FLOW_SKILL_TARGETS env > defaults
TARGETS=()
if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
elif [ -n "${AGENT_FLOW_SKILL_TARGETS:-}" ]; then
  IFS=':' read -ra TARGETS <<< "$AGENT_FLOW_SKILL_TARGETS"
else
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

echo "Canonical skill: $CANONICAL"
echo "Installing into ${#TARGETS[@]} target(s):"
printf '  - %s\n' "${TARGETS[@]}"
echo

for target_dir in "${TARGETS[@]}"; do
  # Expand a leading ~ (in case a target was passed literally)
  target_dir="${target_dir/#\~/$HOME}"
  link="$target_dir/$SKILL_NAME"

  # Ensure the host tool's skills directory exists
  mkdir -p "$target_dir"

  if [ -L "$link" ]; then
    existing="$(readlink "$link")"
    if [ "$existing" = "$CANONICAL" ]; then
      echo "[skip]    $link -> already canonical"
      continue
    fi
    echo "[replace] $link -> $existing (stale; relinking to canonical)"
    rm -f "$link"
  elif [ -e "$link" ]; then
    # A real file/dir at the link path: never clobber blindly.
    echo "[abort]   $link exists and is not a symlink; remove it manually to avoid data loss" >&2
    exit 1
  fi

  ln -s "$CANONICAL" "$link"
  echo "[linked]  $link -> $CANONICAL"
done

echo
echo "Done. Verify: ls -la ~/.workbuddy/skills/$SKILL_NAME ~/.trae-cn/skills/$SKILL_NAME"
