#!/usr/bin/env bash
# Install butchr's systemd USER units (butchr + herdr server).
#
# Idempotent: re-running regenerates the units from deploy/*.service,
# overwrites the installed copies, and reloads systemd. It deliberately does NOT
# enable or start anything — enabling a service is a privileged operator action,
# so this script just prints the exact commands for you to run. See CONTRIBUTING.md
# ("Operations runbook").
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_DIR="$PROJECT_DIR/deploy"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# Resolve absolute binary paths so the units don't depend on the user manager's
# minimal PATH at boot.
BUN_BIN="$(command -v bun || true)"
HERDR_BIN="$(command -v herdr || true)"
[[ -n "$BUN_BIN"   ]] || { echo "error: 'bun' not found on PATH"   >&2; exit 1; }
[[ -n "$HERDR_BIN" ]] || { echo "error: 'herdr' not found on PATH" >&2; exit 1; }

mkdir -p "$UNIT_DIR"

install_unit() {
  local name="$1"
  local src="$DEPLOY_DIR/$name"
  local dst="$UNIT_DIR/$name"
  [[ -f "$src" ]] || { echo "error: missing template $src" >&2; exit 1; }
  sed -e "s|@REPO_DIR@|$PROJECT_DIR|g" \
      -e "s|@BUN@|$BUN_BIN|g" \
      -e "s|@HERDR@|$HERDR_BIN|g" \
      "$src" > "$dst"
  echo "installed $dst"
}

install_unit butchr.service
install_unit herdr.service
systemctl --user daemon-reload
echo "daemon-reload complete"

# Make the "open terminal" feature work out of the box. A systemd --user service
# does NOT inherit DISPLAY/XAUTHORITY/WAYLAND_DISPLAY from the graphical session,
# so import the current (graphical) shell's copies into the user manager — then a
# (re)started butchr.service inherits them and can spawn a GUI terminal. Best-effort
# and harmless from a non-graphical session (butchr also self-discovers the display
# at runtime — see src/terminal.ts). Re-run this one-liner after a fresh login if
# the display changes (also documented in CONTRIBUTING.md §3).
if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  if systemctl --user import-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY 2>/dev/null; then
    echo "imported DISPLAY/XAUTHORITY/WAYLAND_DISPLAY into the user manager"
  else
    echo "note: could not import graphical env (open-terminal still self-discovers at runtime)"
  fi
else
  echo "note: no DISPLAY/WAYLAND_DISPLAY in this shell; skipped graphical-env import"
  echo "      (open-terminal self-discovers the display at runtime — see CONTRIBUTING.md §3)"
fi

# Best-effort validation of the generated units. Warnings (e.g. about specifiers)
# are harmless; a hard parse error would be worth investigating.
if command -v systemd-analyze >/dev/null 2>&1; then
  if systemd-analyze --user verify \
       "$UNIT_DIR/butchr.service" \
       "$UNIT_DIR/herdr.service"; then
    echo "systemd-analyze verify: OK"
  else
    echo "systemd-analyze verify reported warnings (review above; usually harmless)"
  fi
fi

cat <<EOF

Units installed to: $UNIT_DIR
  butchr.service         butchr server (Bun) — Restart=always
  herdr.service          herdr server (PTY/session manager) — Restart=always

Nothing has been started. To enable + start now (run these yourself):

  systemctl --user enable --now herdr.service
  systemctl --user enable --now butchr.service

So the services keep running after you log out — and auto-start on boot:

  loginctl enable-linger "$USER"

Check status / logs:

  systemctl --user status butchr.service
  journalctl --user -u butchr.service -f

"Open terminal" needs the graphical env. This installer already imported it; after
a fresh login (or if the display changes) re-import + restart butchr:

  systemctl --user import-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY
  systemctl --user restart butchr.service
EOF
