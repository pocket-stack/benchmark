/*
 * shell/jsglue.c — the QuickJS entry points runtime_overrides.h redirects,
 * plus the guest-memory readings the results carry.
 */
#include "jsglue.h"

#include "arena.h"
#include "quickjs.h"

static uint64_t jobs_count;

static void *glue_malloc(JSMallocState *state, size_t size) {
  void *ptr = pb_js_malloc(state, size);
  if (ptr != 0) {
    state->malloc_count += 1;
    state->malloc_size += pb_js_malloc_usable_size(ptr);
  }
  return ptr;
}

static void glue_free(JSMallocState *state, void *ptr) {
  if (ptr == 0) return;
  state->malloc_count -= 1;
  state->malloc_size -= pb_js_malloc_usable_size(ptr);
  pb_js_free(state, ptr);
}

static void *glue_realloc(JSMallocState *state, void *ptr, size_t size) {
  size_t old = ptr == 0 ? 0 : pb_js_malloc_usable_size(ptr);
  void *next;
  if (size == 0) {
    glue_free(state, ptr);
    return 0;
  }
  next = pb_js_realloc(state, ptr, size);
  if (next == 0) return 0;
  if (ptr == 0) state->malloc_count += 1;
  state->malloc_size = state->malloc_size - old + pb_js_malloc_usable_size(next);
  return next;
}

static const JSMallocFunctions functions = {
  glue_malloc,
  glue_free,
  glue_realloc,
  pb_js_malloc_usable_size,
};

JSRuntime *pb_js_new_runtime(void) {
  return JS_NewRuntime2(&functions, 0);
}

int pb_js_execute_pending_job(JSRuntime *rt, JSContext **pctx) {
  int result = JS_ExecutePendingJob(rt, pctx);
  if (result > 0) jobs_count += 1;
  return result;
}

uint64_t pb_js_jobs_count(void) { return jobs_count; }
void pb_js_jobs_reset(void) { jobs_count = 0; }
