#!/usr/bin/env bash
#
# install-skill.sh — symlink the agent-flow-dispatch skill into AI-tool skill dirs.
#
# The skill has a single canonical source of truth at <repo>/skills/agent-flow-dispatch.
# This script fans it out as symlinks into each tool's user-level skills directory.
#
# Why symlinks and not copies: the skill is under active development. A copy would
# drift the moment SKILL.md is edited; a symlink makes repo edits take effect
# immediately with no sync step.
#
# Scope — the links land in USER-level skill dirs (~/.agents/skills, ~/.workbuddy/skills),
# both of which WorkBuddy scans (verified against its path allowlist). So the skill is
# visible from every project, not just this repo. The repo's own ./skills/ dir is NOT
# a project-level skill path (that would be ./.workbuddy/skills), so it is never
# picked up as a project-scoped skill and never shadows this install.
#
# Default targets: ~/.agents/skills (shared, tool-agnostic convention on this machine)
# and ~/.workbuddy/skills. Trae is intentionally NOT a default: its front-end does not
# open a new turn when a background task finishes, so "dispatch and get notified" does not
# hold there — you'd have to poll status yourself.
#
# Usage:
#   ./install-skill.sh                         # default: ~/.agents/skills + ~/.workbuddy/skills
#   ./install-skill.sh /path/a/skills /path/b  # explicit targets (overrides default)
#   AGENT_FLOW_SKILL_TARGETS="~/.x/skills:~/.y" ./install-skill.sh   # env override
#
# This is the DEVELOPER route (symlink to a local clone). End users should install from
# GitHub instead, which needs no clone and is the distribution path that works everywhere:
#   npx -y skills add wuruofan/agent-flow-ex --skill agent-flow-dispatch -g -y
# Don't install both into the same target dir — pick one, delete the other.
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

# Default host tool skill dirs (user-level), most-shared first.
DEFAULT_TARGETS=(
  "$HOME/.agents/skills"
  "$HOME/.workbuddy/skills"
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
echo "Done. Verify:"
for t in "${TARGETS[@]}"; do
  echo "  ls -la ${t/#\~/$HOME}/$SKILL_NAME"
done
