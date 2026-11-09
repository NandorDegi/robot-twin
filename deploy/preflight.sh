#!/usr/bin/env bash
# robot-twin preflight on the NUC. Read-only, except a short ping to the robot.
# Run before every session with the real robot:  sudo bash deploy/preflight.sh
# Exit code = number of FAIL lines.
set -uo pipefail
ENV_FILE=/etc/robot-twin/robot-twin.env
fails=0
pass() { echo -e "\e[32mPASS\e[0m $*"; }
fail() { echo -e "\e[31mFAIL\e[0m $*"; fails=$((fails + 1)); }
info() { echo -e "\e[33mINFO\e[0m $*"; }
# shellcheck disable=SC1090
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; else fail "no $ENV_FILE"; fi

# Kernel
if uname -v | grep -q PREEMPT_RT || [ "$(cat /sys/kernel/realtime 2>/dev/null)" = 1 ]; then
  pass "PREEMPT_RT kernel: $(uname -r)"
else
  fail "kernel is not PREEMPT_RT: $(uname -r) ($(uname -v))"
fi

# CPU governor
govs="$(cat /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor 2>/dev/null | sort -u | tr '\n' ' ')"
if [ -z "$govs" ]; then info "no cpufreq governor exposed (BIOS-controlled?)"
elif [ "$govs" = "performance " ]; then pass "CPU governor: performance"
else fail "CPU governor: $govs(expected performance; systemctl start robot-cpu-performance)"; fi

# Limits of the bridge service
lim="$(systemctl show robot-franka.service -p LimitRTPRIO -p LimitMEMLOCK 2>/dev/null | tr '\n' ' ')"
case "$lim" in *LimitRTPRIO=99*LimitMEMLOCK=infinity*) pass "robot-franka limits: $lim" ;; *) fail "robot-franka limits: $lim" ;; esac

# Single commander
if systemctl is-active --quiet robot-ros.service; then fail "robot-ros.service is active: only one process may command the arm"; else pass "robot-ros.service not active"; fi
n_bridge="$(pgrep -fc 'franka_bridge.py' || true)"
[ "${n_bridge:-0}" -le 1 ] && pass "franka bridge processes: ${n_bridge:-0}" || fail "$n_bridge franka bridge processes"

# FCI NIC
NIC="${FCI_NIC:-}"
if [ -z "$NIC" ] || [ "$NIC" = "enp0s0-CHANGE-ME" ]; then
  fail "FCI_NIC not set in $ENV_FILE"
elif ! ip link show "$NIC" >/dev/null 2>&1; then
  fail "FCI_NIC=$NIC does not exist"
else
  state="$(cat /sys/class/net/$NIC/operstate)"; mtu="$(cat /sys/class/net/$NIC/mtu)"
  [ "$state" = up ] && pass "$NIC link up" || fail "$NIC link is $state (cable to the CONTROL shop-floor port?)"
  [ "$mtu" = 1500 ] && pass "$NIC MTU 1500" || fail "$NIC MTU $mtu (use 1500)"
  ip -4 addr show "$NIC" | grep -q "inet ${FCI_HOST_CIDR%/*}/" && pass "$NIC has ${FCI_HOST_CIDR:-?}" || fail "$NIC does not have ${FCI_HOST_CIDR:-?}"
  if command -v nmcli >/dev/null 2>&1 && nmcli -t -f DEVICE,STATE device 2>/dev/null | grep -q "^$NIC:connected"; then
    fail "NetworkManager manages $NIC (run deploy/setup-fci-network.sh)"
  else pass "NetworkManager does not manage $NIC"; fi
  r="$(ip route get "${FRANKA_HOST:-0.0.0.0}" 2>/dev/null)"
  case "$r" in *" dev $NIC "*) pass "route to FRANKA_HOST=$FRANKA_HOST goes via $NIC" ;; *) fail "route to FRANKA_HOST=${FRANKA_HOST:-?} does not go via $NIC: $r" ;; esac
fi

# Robot reachability and latency (ICMP only; FCI itself is not touched)
if [ -n "${FRANKA_HOST:-}" ]; then
  out="$(ping -c 200 -i 0.005 -s 1200 -W 1 "$FRANKA_HOST" 2>&1 | tail -2)"
  loss="$(echo "$out" | grep -o '[0-9.]*% packet loss' | cut -d% -f1)"
  rtt="$(echo "$out" | awk -F'/' '/rtt|round-trip/ {print $6}')"  # max
  if [ "${loss:-100}" = 0 ]; then pass "ping $FRANKA_HOST: 0% loss, max rtt ${rtt:-?} ms"; else fail "ping $FRANKA_HOST: ${loss:-100}% loss"; fi
  awk -v m="${rtt:-99}" 'BEGIN{exit !(m < 1.0)}' && pass "max rtt < 1 ms" || fail "max rtt ${rtt:-?} ms (FCI needs well under 1 ms)"
fi

# Config sanity
[ "${FRANKA_DRY_RUN:-1}" = 1 ] && info "FRANKA_DRY_RUN=1: the bridge does NOT connect to the robot" || info "FRANKA_DRY_RUN=0: the bridge connects to the REAL robot"
awk -v s="${FRANKA_SPEED_FACTOR:-1}" 'BEGIN{exit !(s <= 0.2)}' && pass "FRANKA_SPEED_FACTOR=${FRANKA_SPEED_FACTOR:-}" || info "FRANKA_SPEED_FACTOR=${FRANKA_SPEED_FACTOR:-} (> 0.2: not for a first run)"
for p in 3001 3002 8081 8090 8095; do
  if ss -ltnH "sport = :$p" 2>/dev/null | grep -qv '127.0.0.1'; then fail "port $p listens on a non-loopback address"; fi
done
pass "ports 3001/3002/8081/8090/8095 loopback-only (when running)"

# The brain (decision maker of the chess loop; there is no engine fallback)
for u in robot-intuition:8095 robot-reflection:8090; do
  unit="${u%%:*}"; port="${u#*:}"
  if [ ! -f "/etc/systemd/system/$unit.service" ]; then fail "$unit not installed (deploy/brain/install-brain.sh)"
  elif ! systemctl is-active --quiet "$unit"; then info "$unit installed, not running (start it before the chess loop)"
  elif curl -fsS -m 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then pass "$unit healthy (127.0.0.1:$port)"
  else fail "$unit running but not healthy on 127.0.0.1:$port (journalctl -u $unit)"; fi
done
[ "${BRAIN_OBSERVER:-vision}" = sim ] && [ "${FRANKA_DRY_RUN:-1}" = 0 ] && fail "BRAIN_OBSERVER=sim with the real robot: no camera check"

echo "---"
[ "$fails" -eq 0 ] && echo "preflight: all checks passed" || echo "preflight: $fails check(s) FAILED"
exit "$fails"
