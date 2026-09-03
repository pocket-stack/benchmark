# plugin/Makefile — build the pocketcount TCG plugin against the pinned QEMU's
# plugin header. QEMU_VERSION must match ref/ (the plugin ABI is per release).
#
#   make                 # fetch vendor/qemu-plugin.h (if absent) and build libpocketcount.so
#   make check           # syntax-only compile (works on macOS without QEMU)
#   make QEMU_VERSION=10.2.0
#
# The default is the combination the smoke test has actually passed against
# (plugin/smoke/, Debian trixie's QEMU). When ref/ pins its QEMU, change this
# default to the same version AND re-run `sh plugin/smoke/run.sh`.

QEMU_VERSION ?= 10.0.11
QEMU_HEADER_URL = https://gitlab.com/qemu-project/qemu/-/raw/v$(QEMU_VERSION)/include/qemu/qemu-plugin.h
CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=gnu11
GLIB_CFLAGS := $(shell pkg-config --cflags glib-2.0 2>/dev/null)
GLIB_LIBS := $(shell pkg-config --libs glib-2.0 2>/dev/null)

.PHONY: all check clean header

all: libpocketcount.so

header: vendor/qemu-plugin.h

vendor/qemu-plugin.h:
	mkdir -p vendor
	curl -sfL "$(QEMU_HEADER_URL)" -o $@ || (rm -f $@; echo "cannot fetch $(QEMU_HEADER_URL)"; exit 1)

libpocketcount.so: pocketcount.c vendor/qemu-plugin.h
	$(CC) $(CFLAGS) -fPIC -shared -Ivendor $(GLIB_CFLAGS) $< -o $@ $(GLIB_LIBS)

check: vendor/qemu-plugin.h
	$(CC) $(CFLAGS) -fsyntax-only -Ivendor $(GLIB_CFLAGS) pocketcount.c

clean:
	rm -f libpocketcount.so
