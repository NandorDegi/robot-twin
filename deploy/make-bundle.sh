#!/usr/bin/env bash
# Build the NUC bundle from the committed tree (dev machine):
#   bash deploy/make-bundle.sh   ->  dist/robot-twin-nuc-<date>.tar.gz (+ .sha256)
# Only committed files go in (git archive): source, lockfiles, deploy/, docs/.
# No node_modules, no build output, no untracked files.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
git diff --quiet && git diff --cached --quiet || { echo "commit your changes first" >&2; exit 1; }
name="robot-twin-nuc-$(date +%F)"
mkdir -p dist
git archive --format=tar --prefix=robot-twin/ HEAD | gzip -9 > "dist/$name.tar.gz"
(cd dist && sha256sum "$name.tar.gz" > "$name.tar.gz.sha256")
echo "dist/$name.tar.gz ($(du -h "dist/$name.tar.gz" | cut -f1), commit $(git rev-parse --short HEAD))"
cat "dist/$name.tar.gz.sha256"
