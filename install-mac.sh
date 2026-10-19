#!/bin/bash
# Installs Afterglow via Adobe's own plugin installer (UPIA),
# so Creative Cloud knows the plugin and doesn't drop it from the list again.
# Restart Photoshop afterwards: Plugins > Afterglow.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

rm -f "$HERE/dist/Afterglow.ccx"
mkdir -p "$HERE/dist"
(cd "$HERE/glow" && zip -qr "$HERE/dist/Afterglow.ccx" . -x '.*')

# only remove if already installed (otherwise the installer hangs)
if "$UPIA" --list all 2>/dev/null | grep -q "Afterglow"; then
  "$UPIA" --remove "Afterglow" >/dev/null 2>&1 || true
fi
"$UPIA" --install "$HERE/dist/Afterglow.ccx"
echo "Done. Restart Photoshop > Plugins > Afterglow"
