#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# robot-twin install script for the Intel NUC (x86_64, Ubuntu 22.04).
#
# Run from the unpacked bundle, as root:
#   sudo bash deploy/install.sh [--with-libfranka-examples] [--with-ros]
#
# Default install (the supported v1 path):
#   - user robot-twin, group realtime, RT limits, CPU governor service
#   - app copy in /opt/robot-twin/app, Node.js (checksum-verified), pnpm deps,
#     twin build, Python venvs for the Franka bridge (panda-py) and vision
#   - systemd units robot-franka, robot-server, robot-vision, Caddy
#   - /etc/robot-twin/robot-twin.env from the template (never overwritten)
# It does NOT install the real-time kernel (needs your Ubuntu Pro token, see
# docs/NUC-BRINGUP.md), does NOT configure the FCI NIC (run
# deploy/setup-fci-network.sh), does NOT start a service, and never contacts
# the robot.
#
# --with-libfranka-examples  build libfranka (LIBFRANKA_VERSION, default 0.9.2)
#                            examples: communication_test, echo_robot_state.
# --with-ros                 OPTIONAL ROS 2 Humble + ws_bridge. Off by default:
#                            franka_ros2 main targets the FR3 and a newer
#                            libfranka; a Panda needs FRANKA_ROS2_REF set to a
#                            release that supports libfranka 0.9.x.
#
# The script is idempotent: run it again after an update of the bundle.
# ---------------------------------------------------------------------------
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX=/opt/robot-twin
APP="$PREFIX/app"
ETC=/etc/robot-twin
ENV_FILE="$ETC/robot-twin.env"
STATE=/var/lib/robot-twin
RUN_USER=robot-twin
NODE_VERSION="${NODE_VERSION:-22.23.2}"
PNPM_VERSION="${PNPM_VERSION:-11.22.0}"
LIBFRANKA_VERSION="${LIBFRANKA_VERSION:-0.9.2}"
FRANKA_ROS2_REF="${FRANKA_ROS2_REF:-}"
WITH_ROS=0
WITH_EXAMPLES=0

for arg in "$@"; do
  case "$arg" in
    --with-ros) WITH_ROS=1 ;;
    --with-libfranka-examples) WITH_EXAMPLES=1 ;;
    -h|--help) sed -n 2,30p "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

log() { echo -e "\e[1;32m[install]\e[0m $*"; }
warn() { echo -e "\e[1;33m[install] WARNING:\e[0m $*" >&2; }
die() { echo -e "\e[1;31m[install] ERROR:\e[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash deploy/install.sh"
# INSTALL_ALLOW_ANY_ARCH=1 is only for testing this script on another machine.
[ "$(uname -m)" = "x86_64" ] || [ "${INSTALL_ALLOW_ANY_ARCH:-0}" = 1 ] || die "this script is for the x86_64 NUC (found $(uname -m))"
case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; aarch64) NODE_ARCH=arm64 ;; *) die "no Node.js build for $(uname -m)" ;; esac
. /etc/os-release
[ "${VERSION_ID:-}" = "22.04" ] || die "Ubuntu 22.04 expected (found ${PRETTY_NAME:-unknown})"
[ -f "$SRC/pnpm-lock.yaml" ] && [ -d "$SRC/apps/franka" ] || die "run from the unpacked robot-twin bundle"

# --- 1. system packages ------------------------------------------------------
log "1/9 system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg xz-utils git rsync \
  python3 python3-venv python3-pip \
  build-essential cmake pkg-config \
  rt-tests ethtool iproute2 iputils-ping v4l-utils \
  libgl1 libglib2.0-0

# --- 2. user, groups, real-time limits ---------------------------------------
log "2/9 user $RUN_USER, group realtime, RT limits"
getent group realtime >/dev/null || groupadd --system realtime
if ! id "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$RUN_USER" --shell /usr/sbin/nologin "$RUN_USER"
fi
usermod -aG realtime,video,dialout "$RUN_USER"
# For interactive tools (communication_test, cyclictest) run by a person in
# group realtime. systemd services do NOT read limits.conf: the units set
# LimitRTPRIO / LimitMEMLOCK themselves.
cat > /etc/security/limits.d/99-robot-twin-realtime.conf <<'EOF'
@realtime  -  rtprio   99
@realtime  -  priority 99
@realtime  -  memlock  unlimited
EOF
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  usermod -aG realtime "$SUDO_USER"
  log "    added $SUDO_USER to group realtime (log out and in again)"
fi

# --- 3. app copy and config --------------------------------------------------
log "3/9 app copy in $APP"
install -d -m 0755 "$PREFIX" "$APP"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .venv --exclude __pycache__ \
  --exclude .git --exclude .pytest_cache \
  "$SRC/" "$APP/"
chown -R root:root "$APP"
install -d -m 0750 -o root -g "$RUN_USER" "$ETC"
if [ ! -f "$ENV_FILE" ]; then
  install -m 0640 -o root -g "$RUN_USER" "$SRC/deploy/robot-twin.env.template" "$ENV_FILE"
  log "    created $ENV_FILE: edit the MUST-SET values"
else
  log "    kept existing $ENV_FILE"
fi
install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$STATE" "$STATE/vision"

# --- 4. Node.js + pnpm, JS deps, twin build ----------------------------------
log "4/9 Node.js $NODE_VERSION, pnpm $PNPM_VERSION"
NODE_DIR="$PREFIX/node"
if [ ! -x "$NODE_DIR/bin/node" ] || [ "$("$NODE_DIR/bin/node" -v)" != "v$NODE_VERSION" ]; then
  tmp="$(mktemp -d)"
  tarball="node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -) || die "Node.js checksum mismatch"
  rm -rf "$NODE_DIR" && install -d "$NODE_DIR"
  tar -xJf "$tmp/$tarball" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
fi
export PATH="$NODE_DIR/bin:$PATH"
corepack enable --install-directory "$NODE_DIR/bin"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare "pnpm@$PNPM_VERSION" --activate
(cd "$APP" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile)
(cd "$APP" && pnpm --filter twin build)
install -d -m 0755 "$PREFIX/twin"
rsync -a --delete "$APP/apps/twin/dist/" "$PREFIX/twin/"

# --- 5. Python venvs ----------------------------------------------------------
log "5/9 Python venvs (Franka bridge with panda-py, vision)"
for v in franka vision; do
  [ -x "$PREFIX/$v-venv/bin/python" ] || python3 -m venv "$PREFIX/$v-venv"
  "$PREFIX/$v-venv/bin/pip" install --upgrade --quiet pip
done
if [ -f "$ETC/franka-constraints.txt" ]; then
  "$PREFIX/franka-venv/bin/pip" install --quiet -r "$APP/apps/franka/requirements.txt" -c "$ETC/franka-constraints.txt"
else
  "$PREFIX/franka-venv/bin/pip" install --quiet -r "$APP/apps/franka/requirements.txt"
  "$PREFIX/franka-venv/bin/pip" freeze > "$ETC/franka-constraints.txt"
  log "    pinned the installed versions in $ETC/franka-constraints.txt"
fi
"$PREFIX/franka-venv/bin/python" -c "import panda_py, panda_py.libfranka" \
  || die "panda-py does not import; see docs/NUC-BRINGUP.md step 5"
"$PREFIX/vision-venv/bin/pip" install --quiet -r "$APP/apps/vision/requirements.txt"
"$PREFIX/vision-venv/bin/python" -c "import cv2, numpy; assert hasattr(cv2, 'aruco')" \
  || die "OpenCV with aruco does not import in the vision venv"

# --- 6. optional: libfranka examples ------------------------------------------
if [ "$WITH_EXAMPLES" = 1 ]; then
  log "6/9 libfranka $LIBFRANKA_VERSION examples (communication_test, echo_robot_state)"
  apt-get install -y --no-install-recommends libpoco-dev libeigen3-dev
  LF="$PREFIX/libfranka-$LIBFRANKA_VERSION"
  if [ ! -x "$LF/build/examples/communication_test" ]; then
    rm -rf "$LF"
    git clone --recursive --depth 1 --branch "$LIBFRANKA_VERSION" https://github.com/frankaemika/libfranka.git "$LF"
    cmake -S "$LF" -B "$LF/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=ON
    cmake --build "$LF/build" -j"$(nproc)" --target communication_test echo_robot_state
  fi
  [ -x "$LF/build/examples/communication_test" ] || die "libfranka examples did not build"
else
  log "6/9 libfranka examples: skipped (use --with-libfranka-examples)"
fi

# --- 7. optional: ROS 2 ----------------------------------------------------------
if [ "$WITH_ROS" = 1 ]; then
  log "7/9 OPTIONAL ROS 2 Humble + ws_bridge"
  [ -n "$FRANKA_ROS2_REF" ] || die "--with-ros needs FRANKA_ROS2_REF=<franka_ros2 tag that supports the Panda and libfranka 0.9.x>; see docs/NUC-BRINGUP.md"
  if [ ! -f /etc/apt/sources.list.d/ros2.list ] && ! dpkg -s ros2-apt-source >/dev/null 2>&1; then
    curl -fsSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key | gpg --dearmor --yes -o /usr/share/keyrings/ros-archive-keyring.gpg
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu jammy main" > /etc/apt/sources.list.d/ros2.list
    apt-get update
  fi
  apt-get install -y ros-humble-ros-base ros-humble-moveit ros-humble-ros2-control ros-humble-ros2-controllers \
    ros-humble-xacro python3-colcon-common-extensions python3-rosdep
  [ -f /etc/ros/rosdep/sources.list.d/20-default.list ] || rosdep init
  WS="/home/$RUN_USER/ros_ws"
  sudo -u "$RUN_USER" -H bash -euo pipefail -c "
    source /opt/ros/humble/setup.bash
    mkdir -p '$WS/src'
    [ -d '$WS/src/franka_ros2' ] || git clone https://github.com/frankaemika/franka_ros2.git '$WS/src/franka_ros2'
    git -C '$WS/src/franka_ros2' fetch --tags
    git -C '$WS/src/franka_ros2' checkout '$FRANKA_ROS2_REF'
    rsync -a --delete '$APP/apps/ws_bridge/' '$WS/src/ws_bridge/'
    python3 -m pip install --user 'websockets>=10.4,<14'
    rosdep update
    rosdep install --from-paths '$WS/src' --ignore-src -y --rosdistro humble --skip-keys libfranka
  " || warn "rosdep/clone step failed: read the output above; the ROS path is optional"
  log "    franka_ros2 needs libfranka $LIBFRANKA_VERSION installed system-wide; build and install it, then:"
  log "    sudo -u $RUN_USER bash -c 'source /opt/ros/humble/setup.bash && cd $WS && colcon build --cmake-args -DCMAKE_BUILD_TYPE=Release'"
  install -m 0644 "$APP/deploy/systemd/robot-ros.service" /etc/systemd/system/
else
  log "7/9 ROS 2: skipped (optional, --with-ros)"
fi

# --- 8. Caddy ---------------------------------------------------------------------
log "8/9 Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
install -m 0644 "$APP/deploy/Caddyfile" /etc/caddy/Caddyfile
[ -f "$ETC/caddy.env" ] || install -m 0644 "$APP/deploy/caddy.env.template" "$ETC/caddy.env"
install -d /etc/systemd/system/caddy.service.d
install -m 0644 "$APP/deploy/systemd/caddy-robot-twin.conf" /etc/systemd/system/caddy.service.d/robot-twin.conf

# --- 9. systemd units -----------------------------------------------------------
log "9/9 systemd units"
for u in robot-franka.service robot-server.service robot-vision.service robot-cpu-performance.service; do
  install -m 0644 "$APP/deploy/systemd/$u" /etc/systemd/system/
done
# Units of the generated version: remove so they cannot run next to the bridge.
for old in robot.stack.service robot.vision.service; do
  if [ -f "/etc/systemd/system/$old" ]; then
    systemctl disable --now "$old" 2>/dev/null || true
    rm -f "/etc/systemd/system/$old"
  fi
done
systemctl daemon-reload
systemctl enable robot-cpu-performance.service

# --- checks that must not pass silently --------------------------------------------
if ! uname -v | grep -q PREEMPT_RT; then
  warn "the running kernel is not PREEMPT_RT ($(uname -r)). Install the real-time kernel before you connect the robot (docs/NUC-BRINGUP.md step 2)."
fi
grep -q "CHANGE-ME" "$ENV_FILE" && warn "$ENV_FILE still has CHANGE-ME values (FCI_NIC)."

log "Done. Nothing was started. Next (docs/NUC-BRINGUP.md):"
log "  edit $ENV_FILE and $ETC/caddy.env; sudo bash $APP/deploy/setup-fci-network.sh"
log "  sudo bash $APP/deploy/preflight.sh"
log "  sudo systemctl start robot-franka robot-vision robot-server caddy   (FRANKA_DRY_RUN=1 first)"
