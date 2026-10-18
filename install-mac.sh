#!/bin/bash
# Installs MS Glow via Adobe's own plugin installer (UPIA),
# so Creative Cloud knows the plugin and doesn't drop it from the list again.
# Restart Photoshop afterwards: Plugins > MS Glow.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

rm -f "$HERE/dist/MS-Glow.ccx"
mkdir -p "$HERE/dist"
(cd "$HERE/glow" && zip -qr "$HERE/dist/MS-Glow.ccx" . -x '.*')

# only remove if already installed (otherwise the installer hangs)
if "$UPIA" --list all 2>/dev/null | grep -q "MS Glow"; then
  "$UPIA" --remove "MS Glow" >/dev/null 2>&1 || true
fi
"$UPIA" --install "$HERE/dist/MS-Glow.ccx"
echo "Done. Restart Photoshop > Plugins > MS Glow"
