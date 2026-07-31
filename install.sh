#!/usr/bin/env bash
#
# Install nightshift into an existing project.
#
#   ./install.sh /path/to/your-project
#
# Vendors a single zero-dependency runner, the three skills, and a starter config.
# Never overwrites a file you already have.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }

if [ -z "$TARGET" ]; then
  red "Usage: ./install.sh /path/to/your-project"
  exit 1
fi

if [ ! -d "$TARGET" ]; then
  red "Not a directory: $TARGET"
  exit 1
fi

TARGET="$(cd "$TARGET" && pwd)"

if ! git -C "$TARGET" rev-parse --show-toplevel >/dev/null 2>&1; then
  red "Not a git repository: $TARGET"
  echo "nightshift needs git — every guardrail is built on commits."
  exit 1
fi

ROOT="$(git -C "$TARGET" rev-parse --show-toplevel)"
echo ""
echo "Installing nightshift into $ROOT"
echo ""

copy_if_absent() {
  local from="$1" to="$2" label="$3"
  if [ -e "$to" ]; then
    dim "  skip    $label (already exists)"
  else
    mkdir -p "$(dirname "$to")"
    cp "$from" "$to"
    green "  added   $label"
  fi
}

# The runner is a single file with no dependencies — vendor it so it's versioned
# alongside the project it runs against.
cp "$SRC/bin/nightshift.mjs" "$ROOT/nightshift.mjs"
green "  added   nightshift.mjs"

for skill in night-plan night-task morning-report; do
  copy_if_absent "$SRC/.claude/skills/$skill/SKILL.md" \
                 "$ROOT/.claude/skills/$skill/SKILL.md" \
                 ".claude/skills/$skill/SKILL.md"
done

copy_if_absent "$SRC/templates/nightshift.config.json" "$ROOT/nightshift.config.json" "nightshift.config.json"
copy_if_absent "$SRC/templates/NIGHT_PLAN.md"          "$ROOT/NIGHT_PLAN.md"          "NIGHT_PLAN.md"

# Run logs must survive `git clean -fd` between tasks, which means staying ignored.
if ! grep -qx '\.nightshift/' "$ROOT/.gitignore" 2>/dev/null; then
  printf '\n# nightshift run logs (must stay ignored so they survive task resets)\n.nightshift/\n' >> "$ROOT/.gitignore"
  green "  added   .nightshift/ to .gitignore"
else
  dim "  skip    .gitignore entry (already present)"
fi

echo ""
green "Done."
echo ""
echo "Next:"
echo ""
echo "  1. Edit nightshift.config.json — set 'verify' to YOUR project's commands."
echo "     Those commands are the entire safety model. Make them strict."
echo ""
echo "  2. Build tonight's queue:        claude   →   /night-plan"
echo ""
echo "  3. Check it's safe to run:       node nightshift.mjs preflight"
echo "     Rehearse for \$0:              node nightshift.mjs run --dry-run"
echo "     Then, before bed:             node nightshift.mjs run"
echo ""
