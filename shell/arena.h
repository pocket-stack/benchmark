#ifndef PB_ARENA_H
#define PB_ARENA_H

#include <stddef.h>
#include <stdint.h>

#define PB_ARENA_QUICKJS 0
#define PB_ARENA_CORE 1
#define PB_ARENA_COUNT 2

typedef struct {
  uint64_t current_bytes;
  uint64_t peak_bytes;
  uint64_t limit_bytes;
  uint64_t allocations;
  uint64_t failures;
} PbArenaStats;

/* symbian-core `host-allocator` hooks */
void *pocket_host_alloc(size_t size);
void *pocket_host_realloc(void *ptr, size_t size);
void pocket_host_free(void *ptr);

/* QuickJS JSMallocFunctions */
void *pb_js_malloc(void *opaque, size_t size);
void pb_js_free(void *opaque, void *ptr);
void *pb_js_realloc(void *opaque, void *ptr, size_t size);
size_t pb_js_malloc_usable_size(const void *ptr);

void pb_arena_set_limit(int arena, uint64_t bytes);
void pb_arena_stats(int arena, PbArenaStats *out);

#endif
