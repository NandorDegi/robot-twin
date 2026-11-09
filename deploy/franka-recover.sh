#!/usr/bin/env bash
# Operator action after a reflex / error: libfranka automatic error recovery.
# Run it only after you checked WHY the robot stopped, and with the user stop
# in your hand. It does not move the arm.
#   sudo bash deploy/franka-recover.sh
set -euo pipefail
URL="${FRANKA_BRIDGE_URL:-http://127.0.0.1:3002}"
echo "Stopping robot-server so that it releases the command lease..."
systemctl stop robot-server.service
sleep 1.5   # the lease expires after FRANKA_LEASE_TIMEOUT_S (1 s)
token="$(curl -fsS -X POST -H 'Content-Type: application/json' -d '{"owner":"operator-recover"}' "$URL/lease" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
curl -fsS -X POST -H "X-Lease: $token" "$URL/recover"; echo
curl -fsS -X POST -H "X-Lease: $token" "$URL/release" >/dev/null
curl -fsS "$URL/state" | python3 -c 'import json,sys; s=json.load(sys.stdin); print("mode:", s["mode"], "| error:", s["error"] or "-")'
echo "Start the server again when ready: sudo systemctl start robot-server"
