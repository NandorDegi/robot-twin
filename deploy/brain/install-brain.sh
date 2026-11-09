#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install the robot's brain on the NUC (x86_64, Ubuntu 22.04), after
# deploy/install.sh. The brain is the decision maker of the chess loop; there
# is no chess engine to fall back to.
#
#   - intuition: DeepMind searchless_chess 9M (JAX on CPU), apps/intuition
#     sidecar on 127.0.0.1:8095 (robot-intuition.service)
#   - reflection: llama.cpp llama-server + Qwen3-1.7B GGUF on 127.0.0.1:8090
#     (robot-reflection.service)
#   - optional: Maia weights run by lc0 with `go nodes 1` (one network
#     evaluation, no search): WITH_MAIA=1
#
# Run as root after deploy/install.sh (it uses the installed copy in
# /opt/robot-twin/app):
#   sudo bash deploy/brain/install-brain.sh
#   sudo WITH_MAIA=1 bash deploy/brain/install-brain.sh
#   sudo WITH_136M=1 bash deploy/brain/install-brain.sh   # also the 136M network (1.0 GB)
#
# Downloads (approx.): searchless 9M checkpoint 66 MB (SHA-256 checked),
# Qwen3-1.7B Q4_K_M 1.1 GB (pinned revision), llama.cpp source ~50 MB, Maia
# weights 1.3 MB each, lc0 source ~10 MB.
# Licences: searchless_chess code Apache-2.0, weights CC-BY-4.0; python-chess
# GPL-3.0; Qwen3 Apache-2.0; llama.cpp MIT; lc0 and Maia GPL-3.0.
#
# Like install.sh: idempotent, enables the units, does NOT start a service.
# ---------------------------------------------------------------------------
set -euo pipefail

ROBOT=/opt/robot-twin
APP="$ROBOT/app"
PREFIX="$ROBOT/brain"
RUN_USER=robot-twin
SEARCHLESS_COMMIT=${SEARCHLESS_COMMIT:-90ae0e6b121673fc3079aaeffa047580bb600c0a}
SEARCHLESS_9M_SHA256=e7a62f07c14819ec77433f108d3490599cdf097a49afe64f1be3973d19c34eed
LLAMA_CPP_REF=${LLAMA_CPP_REF:-master}   # pin a release tag here once tested on the NUC
GGUF_REPO=${GGUF_REPO:-unsloth/Qwen3-1.7B-GGUF}
GGUF_REV=${GGUF_REV:-d7f544eead698dbd1f15126ef60b45a1e1933222}
GGUF_FILE=${GGUF_FILE:-Qwen3-1.7B-Q4_K_M.gguf}
MAIA_ELO=${MAIA_ELO:-1500}

log() { echo -e "\e[1;32m[brain]\e[0m $*"; }
warn() { echo -e "\e[1;33m[brain] WARNING:\e[0m $*" >&2; }
die() { echo -e "\e[1;31m[brain] ERROR:\e[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash deploy/brain/install-brain.sh"
[ "$(uname -m)" = "x86_64" ] || [ "${INSTALL_ALLOW_ANY_ARCH:-0}" = 1 ] || die "this script is for the x86_64 NUC (found $(uname -m))"
. /etc/os-release
[ "${VERSION_ID:-}" = "22.04" ] || die "Ubuntu 22.04 expected (found ${PRETTY_NAME:-unknown})"
[ -f "$APP/apps/intuition/intuition_server.py" ] && id "$RUN_USER" >/dev/null 2>&1 \
  || die "run deploy/install.sh first (no $APP or no user $RUN_USER)"

log "1/4 system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3-venv python3-pip git curl unzip build-essential cmake
install -d -m 0755 "$PREFIX"

# --- intuition: searchless_chess -------------------------------------------------
log "2/4 intuition: searchless_chess 9M + venv"
if [ ! -d "$PREFIX/searchless/searchless_chess" ]; then
  git clone https://github.com/google-deepmind/searchless_chess.git "$PREFIX/searchless/searchless_chess"
fi
git -C "$PREFIX/searchless/searchless_chess" checkout -q "$SEARCHLESS_COMMIT"
CK="$PREFIX/searchless/searchless_chess/checkpoints"
if [ ! -d "$CK/9M/6400000" ]; then
  curl -fL -o "$CK/9M.zip" https://storage.googleapis.com/searchless_chess/checkpoints/9M.zip
  echo "$SEARCHLESS_9M_SHA256  $CK/9M.zip" | sha256sum -c - || die "9M checkpoint checksum mismatch"
  (cd "$CK" && unzip -q 9M.zip && rm 9M.zip)
fi
if [ "${WITH_136M:-0}" = 1 ] && [ ! -d "$CK/136M" ]; then
  curl -fL -o "$CK/136M.zip" https://storage.googleapis.com/searchless_chess/checkpoints/136M.zip
  (cd "$CK" && unzip -q 136M.zip && rm 136M.zip)
fi
[ -x "$PREFIX/intuition-venv/bin/python" ] || python3 -m venv "$PREFIX/intuition-venv"
"$PREFIX/intuition-venv/bin/pip" install --upgrade --quiet pip
"$PREFIX/intuition-venv/bin/pip" install --quiet -r "$APP/apps/intuition/requirements.txt"
"$PREFIX/intuition-venv/bin/python" -I "$APP/apps/intuition/intuition_server.py" bench --root "$PREFIX/searchless" --model 9M --rounds 1 \
  || die "the intuition bench failed; read the output above"

# --- reflection: llama.cpp + Qwen3 GGUF ---------------------------------------------
log "3/4 reflection: llama.cpp ($LLAMA_CPP_REF) + $GGUF_FILE"
if [ ! -x "$PREFIX/llama.cpp/build/bin/llama-server" ]; then
  rm -rf "$PREFIX/llama.cpp"
  git clone --depth 1 --branch "$LLAMA_CPP_REF" https://github.com/ggml-org/llama.cpp.git "$PREFIX/llama.cpp"
  cmake -S "$PREFIX/llama.cpp" -B "$PREFIX/llama.cpp/build" -DGGML_NATIVE=ON -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release
  cmake --build "$PREFIX/llama.cpp/build" --target llama-server -j "$(nproc)"
fi
install -d -m 0755 "$PREFIX/models"
if [ ! -f "$PREFIX/models/$GGUF_FILE" ]; then
  curl -fL -o "$PREFIX/models/$GGUF_FILE.part" "https://huggingface.co/$GGUF_REPO/resolve/$GGUF_REV/$GGUF_FILE"
  mv "$PREFIX/models/$GGUF_FILE.part" "$PREFIX/models/$GGUF_FILE"
fi

# Optional: Maia via lc0 (CPU backend). The brain runs it with `go nodes 1`.
if [ "${WITH_MAIA:-0}" = 1 ]; then
  log "    optional: lc0 + maia-$MAIA_ELO"
  apt-get install -y --no-install-recommends meson ninja-build libopenblas-dev zlib1g-dev
  if [ ! -x "$PREFIX/lc0/build/release/lc0" ]; then
    rm -rf "$PREFIX/lc0"
    git clone --depth 1 --branch v0.32.1 --recurse-submodules https://github.com/LeelaChessZero/lc0.git "$PREFIX/lc0"
    (cd "$PREFIX/lc0" && ./build.sh)
  fi
  install -d -m 0755 "$PREFIX/maia"
  [ -f "$PREFIX/maia/maia-$MAIA_ELO.pb.gz" ] || curl -fL -o "$PREFIX/maia/maia-$MAIA_ELO.pb.gz" "https://github.com/CSSLab/maia-chess/raw/master/maia_weights/maia-$MAIA_ELO.pb.gz"
  log "    set BRAIN_INTUITION=maia INTUITION_MAIA_WEIGHTS=$PREFIX/maia/maia-$MAIA_ELO.pb.gz INTUITION_LC0_PATH=$PREFIX/lc0/build/release/lc0"
fi
chown -R root:root "$PREFIX"

# --- services ------------------------------------------------------------------------
log "4/4 systemd units robot-intuition, robot-reflection"
for unit in robot-intuition.service robot-reflection.service; do
  sed -e "s#@PREFIX@#$PREFIX#g" -e "s#@APP@#$APP#g" -e "s#@GGUF@#$GGUF_FILE#g" \
    "$APP/deploy/brain/systemd/$unit" > "/etc/systemd/system/$unit"
  chmod 0644 "/etc/systemd/system/$unit"
done
# Units of the brain branch's first version (other names, other paths).
for old in robot.intuition.service robot.reflection.service; do
  if [ -f "/etc/systemd/system/$old" ]; then
    systemctl disable --now "$old" 2>/dev/null || true
    rm -f "/etc/systemd/system/$old"
  fi
done
systemctl daemon-reload
systemctl enable robot-intuition.service robot-reflection.service
[ "$LLAMA_CPP_REF" = master ] && warn "llama.cpp is not pinned (LLAMA_CPP_REF=master): pin the tested tag for a reproducible install."

log "Done. Nothing was started. Next (docs/NUC-BRINGUP.md section 4.1):"
log "  sudo systemctl start robot-intuition robot-reflection"
log "  curl -s 127.0.0.1:8095/health ; curl -s 127.0.0.1:8090/health"
