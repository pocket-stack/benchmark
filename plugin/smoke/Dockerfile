# plugin/smoke — Debian's QEMU (plugins enabled) + toolchains for both test
# kernels, with the matching include/qemu/qemu-plugin.h baked in at
# /opt/qemu-plugin.h.
FROM debian:trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
      qemu-system-arm gcc binutils cmake ninja-build curl ca-certificates python3 \
      pkg-config libglib2.0-dev gcc-arm-linux-gnueabihf \
    && rm -rf /var/lib/apt/lists/*

# Fetch the plugin header for the installed QEMU: exact tag first, then
# major.minor.0 (stable point releases never change the plugin API).
RUN set -e; \
    version=$(qemu-system-aarch64 --version | sed -n 's/^QEMU emulator version \([0-9.]*\).*/\1/p'); \
    base=$(echo "$version" | sed 's/^\([0-9]*\.[0-9]*\)\..*/\1.0/'); \
    for tag in "v$version" "v$base"; do \
      echo "trying qemu-plugin.h from $tag"; \
      curl -sfL "https://gitlab.com/qemu-project/qemu/-/raw/$tag/include/qemu/qemu-plugin.h" -o /opt/qemu-plugin.h && break; \
    done; \
    test -s /opt/qemu-plugin.h; \
    echo "$version" > /opt/qemu-version
