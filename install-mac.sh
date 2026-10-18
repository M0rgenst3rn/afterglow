#!/bin/bash
# Installiert MS Glow über Adobes eigenen Plugin-Installer (UPIA),
# damit Creative Cloud das Plugin kennt und es nicht wieder aus der Liste streicht.
# Danach Photoshop neu starten: Zusatzmodule (Plugins) > MS Glow.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
UPIA="/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent"

rm -f "$HERE/dist/MS-Glow.ccx"
mkdir -p "$HERE/dist"
(cd "$HERE/glow" && zip -qr "$HERE/dist/MS-Glow.ccx" . -x '.*')

# Nur entfernen, wenn schon installiert (sonst hängt der Installer)
if "$UPIA" --list all 2>/dev/null | grep -q "MS Glow"; then
  "$UPIA" --remove "MS Glow" >/dev/null 2>&1 || true
fi
"$UPIA" --install "$HERE/dist/MS-Glow.ccx"
echo "Fertig. Photoshop neu starten > Zusatzmodule (Plugins) > MS Glow"
