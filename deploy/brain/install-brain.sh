#!/usr/bin/env bash
# Install the robot's brain on the NUC (x86_64, Ubuntu 24.04): the intuition
# network (searchless_chess 9M, JAX on CPU) and the reflection SLM (llama.cpp
# llama-server + Qwen3-1.7B GGUF). Optional: Maia via lc0.
#
# Run as the robot user with sudo rights, from the repository root:
#   deploy/brain/install-brain.sh            # intuition + reflection
#   WITH_MAIA=1 deploy/brain/install-brain.sh
#   WITH_136M=1 ...                          # also the 136M network (1.0 GB download)
#
# Downloads (approx.): searchless 9M checkpoint 66 MB, Qwen3-1.7B Q4_K_M 1.1 GB,
# llama.cpp source ~50 MB, Maia weights 1.3 MB each, lc0 source ~10 MB.
# Licences: searchless_chess code Apache-2.0, weights CC-BY-4.0; python-chess GPL-3.0;
# Qwen3 Apache-2.0; llama.cpp MIT; lc0 and Maia GPL-3.0.
set -euo pipefail

PREFIX=${PREFIX:-/opt/robot-brain}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
SEARCHLESS_COMMIT=${SEARCHLESS_COMMIT:-90ae0e6b121673fc3079aaeffa047580bb600c0a}
SEARCHLESS_9M_SHA256=e7a62f07c14819ec77433f108d3490599cdf097a49afe64f1be3973d19c34eed
LLAMA_CPP_REF=${LLAMA_CPP_REF:-master}   # pin a release tag here once tested on the NUC
GGUF_REPO=${GGUF_REPO:-unsloth/Qwen3-1.7B-GGUF}
GGUF_REV=${GGUF_REV:-d7f544eead698dbd1f15126ef60b45a1e1933222}
GGUF_FILE=${GGUF_FILE:-Qwen3-1.7B-Q4_K_M.gguf}
MAIA_ELO=${MAIA_ELO:-1500}

sudo mkdir -p "$PREFIX" && sudo chown "$(id -u):$(id -g)" "$PREFIX"
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip git curl unzip build-essential cmake

# --- 1. intuition: searchless_chess ---------------------------------------------
if [ ! -d "$PREFIX/searchless/searchless_chess" ]; then
  git clone https://github.com/google-deepmind/searchless_chess.git "$PREFIX/searchless/searchless_chess"
  git -C "$PREFIX/searchless/searchless_chess" checkout "$SEARCHLESS_COMMIT"
fi
CK="$PREFIX/searchless/searchless_chess/checkpoints"
if [ ! -d "$CK/9M/6400000" ]; then
  curl -fL -o "$CK/9M.zip" https://storage.googleapis.com/searchless_chess/checkpoints/9M.zip
  echo "$SEARCHLESS_9M_SHA256  $CK/9M.zip" | sha256sum -c -
  (cd "$CK" && unzip -q 9M.zip && rm 9M.zip)
fi
if [ "${WITH_136M:-0}" = 1 ] && [ ! -d "$CK/136M" ]; then
  curl -fL -o "$CK/136M.zip" https://storage.googleapis.com/searchless_chess/checkpoints/136M.zip
  (cd "$CK" && unzip -q 136M.zip && rm 136M.zip)
fi
python3 -m venv "$PREFIX/intuition-venv"
"$PREFIX/intuition-venv/bin/pip" install -q -r "$REPO/apps/intuition/requirements.txt"
"$PREFIX/intuition-venv/bin/python" -I "$REPO/apps/intuition/intuition_server.py" bench --root "$PREFIX/searchless" --model 9M --rounds 1

# --- 2. reflection: llama.cpp + Qwen3 GGUF ----------------------------------------
if [ ! -x "$PREFIX/llama.cpp/build/bin/llama-server" ]; then
  git clone --depth 1 --branch "$LLAMA_CPP_REF" https://github.com/ggml-org/llama.cpp.git "$PREFIX/llama.cpp"
  cmake -S "$PREFIX/llama.cpp" -B "$PREFIX/llama.cpp/build" -DGGML_NATIVE=ON -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release
  cmake --build "$PREFIX/llama.cpp/build" --target llama-server -j "$(nproc)"
fi
mkdir -p "$PREFIX/models"
if [ ! -f "$PREFIX/models/$GGUF_FILE" ]; then
  curl -fL -o "$PREFIX/models/$GGUF_FILE.part" "https://huggingface.co/$GGUF_REPO/resolve/$GGUF_REV/$GGUF_FILE"
  mv "$PREFIX/models/$GGUF_FILE.part" "$PREFIX/models/$GGUF_FILE"
fi

# --- 3. optional: Maia via lc0 (CPU backend) -------------------------------------
if [ "${WITH_MAIA:-0}" = 1 ]; then
  sudo apt-get install -y meson ninja-build libopenblas-dev zlib1g-dev
  if [ ! -x "$PREFIX/lc0/build/release/lc0" ]; then
    git clone --depth 1 --branch v0.32.1 --recurse-submodules https://github.com/LeelaChessZero/lc0.git "$PREFIX/lc0"
    (cd "$PREFIX/lc0" && ./build.sh)
  fi
  mkdir -p "$PREFIX/maia"
  curl -fL -o "$PREFIX/maia/maia-$MAIA_ELO.pb.gz" "https://github.com/CSSLab/maia-chess/raw/master/maia_weights/maia-$MAIA_ELO.pb.gz"
fi

# --- 4. services -----------------------------------------------------------------
for unit in robot.intuition.service robot.reflection.service; do
  sed -e "s#@PREFIX@#$PREFIX#g" -e "s#@REPO@#$REPO#g" -e "s#@USER@#$(id -un)#g" -e "s#@GGUF@#$GGUF_FILE#g" \
    "$REPO/deploy/brain/systemd/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now robot.intuition.service robot.reflection.service
echo "brain installed. Check: curl -s 127.0.0.1:8095/health ; curl -s 127.0.0.1:8090/health"
