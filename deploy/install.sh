#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# robot-twin deploy script for the mini PC / NUC.
#
# Installs ROS 2 Humble + franka_ros2 + MoveIt + the ws_bridge, builds the twin,
# installs a reverse proxy (Caddy) and systemd units, and wires the FCI NIC.
#
# Run on the NUC from the repo root:
#   sudo bash deploy/install.sh
#
# Read the environment from /etc/robot-twin.env (see deploy/.env.example).
# This script does NOT touch the Panda; it only prepares the compute box.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/robot-twin.env
ROS_DISTRO="${ROS_DISTRO:-humble}"
ROBOT_TWIN_USER="${ROBOT_TWIN_USER:-robot-twin}"

log() { echo -e "\e[1;32m[deploy]\e[0m $*"; }
die() { echo -e "\e[1;31m[deploy]\e[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo bash deploy/install.sh)"
command -v apt-get >/dev/null || die "this is written for Ubuntu (apt-get)"

log "Reading environment from $ENV_FILE (if present)"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi

log "Installing system packages (curl, git, build tools, Caddy)"
apt-get update
apt-get install -y curl ca-certificates gnupg lsb-release git python3-pip python3-venv \
  build-essential cmake pkg-config libudev-dev

# --- ROS 2 (Ubuntu 22.04 -> Humble) --------------------------------------
log "Installing ROS 2 $ROS_DISTRO"
if ! dpkg -s "ros-${ROS_DISTRO}-ros-base" >/dev/null 2>&1; then
  # ROS 2 apt source for Ubuntu 22.04 (jammy) -> Humble.
  export ROS_APT_SOURCE=ros2
  sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/ros-archive-keyring.gpg] http://packages.ros.org/ros2/ubuntu $(lsb_release -cs) main" > /etc/apt/sources.list.d/ros2.list'
  curl -fsSL https://raw.githubusercontent.com/ros/rosdistro/master/ros.key | gpg --dearmor -o /usr/share/keyrings/ros-archive-keyring.gpg
  apt-get update
  apt-get install -y "ros-${ROS_DISTRO}-ros-base" "ros-${ROS_DISTRO}-ros2-control" \
    "ros-${ROS_DISTRO}-controller-manager" "ros-${ROS_DISTRO}-joint-trajectory-controller" \
    "ros-${ROS_DISTRO}-moveit" "ros-${ROS_DISTRO}-moveit-ros-planning" \
    "ros-${ROS_DISTRO}-control-msgs" "ros-${ROS_DISTRO}-moveit-msgs" \
    "ros-${ROS_DISTRO}-ros2-control" "ros-${ROS_DISTRO}-ros2-controllers" \
    "ros-${ROS_DISTRO}-xacro" "ros-${ROS_DISTRO}-joint-state-publisher" \
    "ros-${ROS_DISTRO}-launch-ros" "python3-colcon-common-extensions"
fi

# franka_ros2 is not always in the apt cloud; fall back to a source build.
if ! dpkg -s "ros-${ROS_DISTRO}-franka-ros2" >/dev/null 2>&1; then
  log "franka_ros2 not in apt; building from source into ~/ros_ws"
  sudo -u "$ROBOT_TWIN_USER" bash -c '
    set -e
    source /opt/ros/'"$ROS_DISTRO"'/setup.bash
    mkdir -p ~/ros_ws/src && cd ~/ros_ws/src
    git clone --depth 1 https://github.com/frankaemika/franka_ros2.git
    cd ~/ros_ws
    colcon build --symlink-install
  ' || log "warning: source build of franka_ros2 failed; check README of franka_ros2 for apt alias"
fi

# --- Build the ws_bridge package -----------------------------------------
log "Building the ws_bridge ROS 2 package"
sudo -u "$ROBOT_TWIN_USER" bash -c '
  set -e
  source /opt/ros/'"$ROS_DISTRO"'/setup.bash
  pip install websockets
  cd '"$REPO"'/apps/ws_bridge
  # Install the bridge into the user ROS workspace so `ros2 launch ws_bridge` works.
  mkdir -p ~/ros_ws/src && cp -r . ~/ros_ws/src/ws_bridge
  cd ~/ros_ws && colcon build --symlink-install --packages-select ws_bridge
'

# --- Build the twin static bundle ----------------------------------------
log "Building the twin UI"
if command -v pnpm >/dev/null 2>&1; then
  (cd "$REPO" && pnpm --filter twin build) || log "pnpm build failed; check Node/pnpm"
else
  log "pnpm not installed; build the twin with 'pnpm --filter twin build' on a dev box"
fi

# --- Vision service (camera + board detection) ----------------------------
log "Setting up the vision service (venv + modules)"
install -d -o "$ROBOT_TWIN_USER" -g "$ROBOT_TWIN_USER" /opt/robot-twin/vision
cp -r "$REPO/apps/vision/." /opt/robot-twin/vision/
sudo -u "$ROBOT_TWIN_USER" bash -c '
  python3 -m venv /opt/robot-twin/vision-venv
  /opt/robot-twin/vision-venv/bin/pip install --upgrade pip
  /opt/robot-twin/vision-venv/bin/pip install -r '"$REPO"'/apps/vision/requirements.txt
'

# --- Caddy reverse proxy --------------------------------------------------
log "Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update && apt-get install -y caddy
fi
install -m 0644 "$REPO/deploy/Caddyfile" /etc/caddy/Caddyfile
install -d -o "$ROBOT_TWIN_USER" -g "$ROBOT_TWIN_USER" "$REPO/deploy/twin-dist"
# Serve the built twin from /opt/robot-twin/twin (Caddyfile points here).
install -d -o "$ROBOT_TWIN_USER" -g "$ROBOT_TWIN_USER" /opt/robot-twin/twin
if [ -d "$REPO/apps/twin/dist" ]; then
  cp -r "$REPO/apps/twin/dist/." /opt/robot-twin/twin/
fi

# --- systemd units --------------------------------------------------------
log "Installing systemd units"
install -m 0644 "$REPO/deploy/systemd/robot.stack.service" /etc/systemd/system/
install -m 0644 "$REPO/deploy/systemd/robot.vision.service" /etc/systemd/system/
# Make the env file available to the units.
[ -f "$ENV_FILE" ] || cp "$REPO/deploy/.env.example" "$ENV_FILE"
chmod 0644 "$ENV_FILE"
systemctl daemon-reload

log "Done. Next steps:"
log "  1. Edit $ENV_FILE (FRANKA_HOST, FRANKA_NIC, camera index)."
log "  2. On the Panda control unit: enable FCI, release brakes, Activate FCI."
log "  3. Start: systemctl enable --now robot.stack robot.vision caddy"
log "  4. Open the twin at http://\${TWIN_HOST}:\${TWIN_PORT} and drag the sphere."
log "See deploy/DEPLOY.md for the full runbook."
