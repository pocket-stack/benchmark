#!/bin/sh
# plugin/smoke/run.sh — build the smoke image and run the pocketcount smoke
# test in it. Run from anywhere; only the repo's plugin/ directory is mounted
# (read-only). See inside.sh for what actually happens.
set -eu

PLUGIN_DIR=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=pocketcount-smoke

docker build -t "$IMAGE" "$PLUGIN_DIR/smoke"
exec docker run --rm -v "$PLUGIN_DIR":/plugin:ro "$IMAGE" sh /plugin/smoke/inside.sh
