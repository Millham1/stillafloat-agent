#!/bin/sh
# Installs (or refreshes) the Allianz worker on Mark's Mac. Run it ON THE MAC, from anywhere:
#     sh server/tools/allianz-mac/install.sh
# Mark 2026-11-14: "you need to code this into the process, to use my local to connect to Allianz. we will need it for future quotes".
# Allianz lets his own computer in and turns the servers away, so the sites only queue an Allianz request and this worker does the asking.
# What it does: builds the worker from this checkout into ONE file, writes run.sh and the README beside it, and has launchd start a pass
# every minute. It never writes the private settings file: that one holds the sites' tokens and the Allianz sign-in
# (~/.config/saf/allianz-worker.env, mode 600), and is written once by hand from the box's shared.env (see README.md here).
# Run it again after lib/allianz-quote.ts or allianz-mac-worker.ts changes: the Mac runs the copy this script builds, not the repo.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; SERVER="$(cd "$HERE/../.." && pwd)"
DEST="${ALLIANZ_MAC_DIR:-$HOME/Desktop/Claude Local/saf-ops-tools/allianz-mac}"
NODE="${NODE:-$HOME/.local/bin/node}"; [ -x "$NODE" ] || NODE="$(command -v node)"
LABEL=com.stillafloat.allianz-mac; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"; LOG="$HOME/Library/Logs/saf-allianz-mac.log"
SETTINGS="$HOME/.config/saf/allianz-worker.env"
mkdir -p "$DEST" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
(cd "$SERVER" && "$NODE" build-allianz-mac-worker.mjs "$DEST")
cat > "$DEST/run.sh" <<RUN
#!/bin/sh
# One pass of the Allianz worker on this Mac. launchd runs it every minute ($PLIST). By hand:  sh run.sh
S="\$(cd "\$(dirname "\$0")" && pwd)"
set -a; . "$SETTINGS"; set +a
exec "$NODE" "\$S/allianz-mac-worker.mjs"
RUN
chmod 755 "$DEST/run.sh"
cp "$HERE/README.md" "$DEST/README.txt"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$DEST/run.sh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL
plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
[ -f "$SETTINGS" ] || echo "NOT READY: $SETTINGS does not exist yet. Write it (README.md), then the worker starts answering."
echo "installed: $DEST · runs every minute · log $LOG"
