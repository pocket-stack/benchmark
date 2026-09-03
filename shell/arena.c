/*
 * shell/arena.c — the two allocators the shell owns.
 *
 * The core (pocket-bench, built with symbian-core's `host-allocator`) calls
 * pocket_host_alloc / realloc / free; QuickJS is created through
 * JS_NewRuntime2 with the functions below (the observe and measure builds
 * both route it here, see generated/record_ops.h and main.c). Every block
 * carries a 16-byte size header so current and peak usage are exact, and
 * a runtime cap turns an allocation that would exceed it into NULL — that
 * is what `min_pass_arena_bytes` scans. Both host and SO3 builds draw from
 * libc malloc while this layer provides exact accounting and optional caps.
 */
#include "arena.h"

#include <stdlib.h>
#include <string.h>

#define PB_ARENA_HEADER 16

typedef struct {
  uint64_t current;
  uint64_t peak;
  uint64_t limit; /* 0 = unlimited */
  uint64_t allocations;
  uint64_t failures;
} PbArena;

static PbArena arenas[PB_ARENA_COUNT];

static void *arena_alloc(PbArena *arena, size_t size) {
  uint8_t *block;
  if (arena->limit != 0 && arena->current + size > arena->limit) {
    arena->failures += 1;
    return NULL;
  }
  block = (uint8_t *)malloc(size + PB_ARENA_HEADER);
  if (block == NULL) {
    arena->failures += 1;
    return NULL;
  }
  memcpy(block, &size, sizeof(size));
  arena->current += size;
  arena->allocations += 1;
  if (arena->current > arena->peak) arena->peak = arena->current;
  return block + PB_ARENA_HEADER;
}

static size_t block_size(void *ptr) {
  size_t size;
  memcpy(&size, (uint8_t *)ptr - PB_ARENA_HEADER, sizeof(size));
  return size;
}

static void arena_free(PbArena *arena, void *ptr) {
  if (ptr == NULL) return;
  arena->current -= block_size(ptr);
  free((uint8_t *)ptr - PB_ARENA_HEADER);
}

static void *arena_realloc(PbArena *arena, void *ptr, size_t size) {
  size_t old;
  uint8_t *block;
  if (ptr == NULL) return arena_alloc(arena, size);
  if (size == 0) {
    arena_free(arena, ptr);
    return NULL;
  }
  old = block_size(ptr);
  if (arena->limit != 0 && size > old && arena->current - old + size > arena->limit) {
    arena->failures += 1;
    return NULL;
  }
  block = (uint8_t *)realloc((uint8_t *)ptr - PB_ARENA_HEADER, size + PB_ARENA_HEADER);
  if (block == NULL) {
    arena->failures += 1;
    return NULL;
  }
  memcpy(block, &size, sizeof(size));
  arena->current = arena->current - old + size;
  if (arena->current > arena->peak) arena->peak = arena->current;
  return block + PB_ARENA_HEADER;
}

/* ---- core (symbian-core host-allocator hooks) ---------------------------- */

void *pocket_host_alloc(size_t size) { return arena_alloc(&arenas[PB_ARENA_CORE], size); }
void *pocket_host_realloc(void *ptr, size_t size) { return arena_realloc(&arenas[PB_ARENA_CORE], ptr, size); }
void pocket_host_free(void *ptr) { arena_free(&arenas[PB_ARENA_CORE], ptr); }

/* ---- QuickJS (JSMallocFunctions) ---------------------------------------- */

void *pb_js_malloc(void *opaque, size_t size) {
  (void)opaque;
  return arena_alloc(&arenas[PB_ARENA_QUICKJS], size);
}

void pb_js_free(void *opaque, void *ptr) {
  (void)opaque;
  arena_free(&arenas[PB_ARENA_QUICKJS], ptr);
}

void *pb_js_realloc(void *opaque, void *ptr, size_t size) {
  (void)opaque;
  return arena_realloc(&arenas[PB_ARENA_QUICKJS], ptr, size);
}

size_t pb_js_malloc_usable_size(const void *ptr) {
  return ptr == NULL ? 0 : block_size((void *)ptr);
}

/* ---- stats ---------------------------------------------------------------- */

void pb_arena_set_limit(int arena, uint64_t bytes) {
  if (arena >= 0 && arena < PB_ARENA_COUNT) arenas[arena].limit = bytes;
}

void pb_arena_stats(int arena, PbArenaStats *out) {
  if (arena < 0 || arena >= PB_ARENA_COUNT || out == NULL) return;
  out->current_bytes = arenas[arena].current;
  out->peak_bytes = arenas[arena].peak;
  out->limit_bytes = arenas[arena].limit;
  out->allocations = arenas[arena].allocations;
  out->failures = arenas[arena].failures;
}
