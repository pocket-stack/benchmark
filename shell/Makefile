# shell/Makefile — the bench shell, two builds × two observers.
#
#   make host            dist/shell/host/pocket-bench-shell + …-observe
#   make so3-arm32       (needs the SO3 musl toolchain from ref/)
#   make so3-aarch64
#   make clean
#
# Sources: this directory, vendor/pocketjs/hosts/soft (pocket_runtime.c),
# vendor/quickjs-rs/libquickjs-sys/embed/quickjs (five .c), and the
# crates/pocket-bench staticlib (built here with cargo; its rust-toolchain.toml
# picks the nightly).

ROOT      := $(abspath ..)
SOFT      := $(ROOT)/vendor/pocketjs/hosts/soft
QUICKJS   := $(ROOT)/vendor/quickjs-rs/libquickjs-sys/embed/quickjs
CRATE     := $(ROOT)/crates/pocket-bench
QJS_VERSION := $(shell cat $(QUICKJS)/VERSION)

CC        ?= cc
CARGO     ?= cargo
SKIP_CARGO ?= 0

# ---- host build --------------------------------------------------------------

HOST_DIR  := $(ROOT)/dist/shell/host
HOST_OBJ  := $(HOST_DIR)/objects
HOST_LIB  := $(CRATE)/target/release/libpocket_bench.a

QJS_CFLAGS := -std=gnu11 -O2 -funsigned-char -fno-strict-aliasing -D_GNU_SOURCE \
              -DCONFIG_VERSION=\"$(QJS_VERSION)\" -I$(QUICKJS) -w
SHELL_CFLAGS := -std=c99 -O2 -Wall -Wextra -fwrapv \
                -DPOCKETJS_TARGET_ID=\"bench\" -DPOCKETJS_HOST_ABI=0 \
                -DPOCKET_RUNTIME_BENCH_HOOKS -DPB_QUICKJS_VERSION=\"$(QJS_VERSION)\" \
                -I$(SOFT) -I. -isystem $(QUICKJS)
RUNTIME_CFLAGS := $(SHELL_CFLAGS) -include runtime_overrides.h

QJS_SOURCES := cutils.c dtoa.c libregexp.c libunicode.c quickjs.c
QJS_OBJECTS := $(patsubst %.c,$(HOST_OBJ)/quickjs-%.o,$(QJS_SOURCES))

SHELL_SOURCES := main.c arena.c vtime.c marks_host.c jsglue.c
SHELL_OBJECTS := $(patsubst %.c,$(HOST_OBJ)/%.o,$(SHELL_SOURCES))
OBSERVE_OBJECTS := $(patsubst %.c,$(HOST_OBJ)/observe-%.o,$(SHELL_SOURCES)) \
                   $(HOST_OBJ)/observe-record.o $(HOST_OBJ)/observe-record_ops.o
GUEST_OBJECTS := $(patsubst %.c,$(HOST_OBJ)/guest-%.o,$(SHELL_SOURCES)) \
                 $(HOST_OBJ)/guest-tape_host.o $(HOST_OBJ)/guest-tape_ops.o

.PHONY: host so3-arm32 so3-aarch64 clean crate

host: $(HOST_DIR)/pocket-bench-shell $(HOST_DIR)/pocket-bench-shell-observe $(HOST_DIR)/pocket-bench-shell-guest

crate:
	cd $(CRATE) && $(CARGO) build --release

$(HOST_LIB): crate

$(HOST_OBJ):
	mkdir -p $(HOST_OBJ)

$(HOST_OBJ)/quickjs-%.o: $(QUICKJS)/%.c | $(HOST_OBJ)
	$(CC) $(QJS_CFLAGS) -c $< -o $@

$(HOST_OBJ)/%.o: %.c | $(HOST_OBJ)
	$(CC) $(SHELL_CFLAGS) -c $< -o $@

$(HOST_OBJ)/observe-%.o: %.c | $(HOST_OBJ)
	$(CC) $(SHELL_CFLAGS) -DPB_OBSERVE -c $< -o $@

$(HOST_OBJ)/observe-record_ops.o: generated/record_ops.c | $(HOST_OBJ)
	$(CC) $(SHELL_CFLAGS) -DPB_OBSERVE -c $< -o $@

$(HOST_OBJ)/guest-%.o: %.c | $(HOST_OBJ)
	$(CC) $(SHELL_CFLAGS) -DPB_GUEST_TAPE -c $< -o $@

$(HOST_OBJ)/guest-tape_ops.o: generated/tape_ops.c | $(HOST_OBJ)
	$(CC) $(SHELL_CFLAGS) -DPB_GUEST_TAPE -c $< -o $@

# pocket_runtime.c: measure build gets the runtime overrides only; the
# observe build also gets every ui_* call renamed into the recorder.
$(HOST_OBJ)/pocket_runtime.o: $(SOFT)/pocket_runtime.c | $(HOST_OBJ)
	$(CC) $(RUNTIME_CFLAGS) -c $< -o $@

$(HOST_OBJ)/observe-pocket_runtime.o: $(SOFT)/pocket_runtime.c generated/record_ops.h | $(HOST_OBJ)
	$(CC) $(RUNTIME_CFLAGS) -DPB_OBSERVE -include generated/record_ops.h -c $< -o $@

$(HOST_OBJ)/rust_eh_personality.o: $(SOFT)/rust_eh_personality.c | $(HOST_OBJ)
	$(CC) $(SHELL_CFLAGS) -c $< -o $@

$(HOST_DIR)/pocket-bench-shell: $(SHELL_OBJECTS) $(HOST_OBJ)/pocket_runtime.o $(HOST_OBJ)/rust_eh_personality.o $(QJS_OBJECTS) $(HOST_LIB)
	$(CC) -o $@ $^ -lm

$(HOST_DIR)/pocket-bench-shell-observe: $(OBSERVE_OBJECTS) $(HOST_OBJ)/observe-pocket_runtime.o $(HOST_OBJ)/rust_eh_personality.o $(QJS_OBJECTS) $(HOST_LIB)
	$(CC) -o $@ $^ -lm

$(HOST_OBJ)/guest-pocket_runtime.o: $(SOFT)/pocket_runtime.c generated/tape_ops.h | $(HOST_OBJ)
	$(CC) $(RUNTIME_CFLAGS) -DPB_GUEST_TAPE -include generated/tape_ops.h -c $< -o $@

$(HOST_DIR)/pocket-bench-shell-guest: $(GUEST_OBJECTS) $(HOST_OBJ)/guest-pocket_runtime.o $(HOST_OBJ)/rust_eh_personality.o $(QJS_OBJECTS) $(HOST_LIB)
	$(CC) -o $@ $^ -lm

# ---- SO3 builds ---------------------------------------------------------------
# Cross toolchains come from the ref/ image (SO3's musl toolchains). Point
# SO3_CC_AARCH64 / SO3_CC_ARM32 at the gcc drivers, e.g.
#   make so3-aarch64 SO3_CC_AARCH64=aarch64-linux-musl-gcc
#   make so3-arm32   SO3_CC_ARM32=arm-linux-musleabihf-gcc
# Static binaries, measure observer only, markers instead of clocks
# (marks_so3.c; the protocol is validated by plugin/smoke). The pocket-bench
# staticlib builds with the crate's pinned nightly for the musl targets
# (`rustup target add aarch64-unknown-linux-musl armv7-unknown-linux-musleabihf`).

SO3_CC_AARCH64 ?=
SO3_CC_ARM32 ?=
SO3_ARM32_FLAGS ?= -march=armv7-a -mthumb -mfpu=neon -mfloat-abi=hard

define SO3_BUILD
	@test -n "$(2)" || { echo "$(1): set $(3) to the SO3 musl gcc (ref/README.md)"; exit 1; }
	mkdir -p $(ROOT)/dist/shell/$(1)/objects
	@if [ "$(SKIP_CARGO)" = "1" ]; then \
	  test -f $(CRATE)/target/$(4)/release/libpocket_bench.a || { echo "$(1): missing prebuilt Rust staticlib for $(4)"; exit 1; }; \
	else \
	  cd $(CRATE) && $(CARGO) build --release --target $(4); \
	fi
	for s in $(QJS_SOURCES); do \
	  $(2) $(QJS_CFLAGS) -Os -static -c $(QUICKJS)/$$s -o $(ROOT)/dist/shell/$(1)/objects/quickjs-$${s%.c}.o || exit 1; \
	done
	for s in main.c arena.c vtime.c marks_so3.c jsglue.c; do \
	  $(2) $(SO3_SHELL_CFLAGS) -c $$s -o $(ROOT)/dist/shell/$(1)/objects/$${s%.c}.o || exit 1; \
	done
	$(2) $(SO3_SHELL_CFLAGS) -include runtime_overrides.h -c $(SOFT)/pocket_runtime.c -o $(ROOT)/dist/shell/$(1)/objects/pocket_runtime.o
	$(2) $(SO3_SHELL_CFLAGS) -c $(SOFT)/rust_eh_personality.c -o $(ROOT)/dist/shell/$(1)/objects/rust_eh_personality.o
	$(2) -static -Wl,-Map=$(ROOT)/dist/shell/$(1)/shell.map -o $(ROOT)/dist/shell/$(1)/pocket-bench-shell \
	  $(ROOT)/dist/shell/$(1)/objects/*.o \
	  $(CRATE)/target/$(4)/release/libpocket_bench.a -lm
endef

SO3_SHELL_CFLAGS = $(filter-out -O2,$(SHELL_CFLAGS)) -Os -static -DPB_HOST_NAME=\"$(SO3_HOST_NAME)\"

so3-aarch64: SO3_HOST_NAME = so3-virt64
so3-aarch64:
	$(call SO3_BUILD,so3-aarch64,$(SO3_CC_AARCH64),SO3_CC_AARCH64,aarch64-unknown-linux-musl)

so3-arm32: SO3_HOST_NAME = so3-virt32
so3-arm32:
	$(call SO3_BUILD,so3-arm32,$(SO3_CC_ARM32) $(SO3_ARM32_FLAGS),SO3_CC_ARM32,armv7-unknown-linux-musleabihf)

clean:
	rm -rf $(ROOT)/dist/shell
