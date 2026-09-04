#!/bin/sh
# plugin/smoke/run.sh — build the smoke image and run the pocketcount smoke
# test in it. Run from anywhere; the repository is mounted read-only. See
# inside.sh for what actually happens.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=pocketcount-smoke

docker build -t "$IMAGE" "$ROOT/plugin/smoke"
exec docker run --rm -v "$ROOT":/repo:ro "$IMAGE" sh /repo/plugin/smoke/inside.sh
