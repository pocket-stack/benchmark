/*
 * shell/main.c — the bench shell (docs/SHELL.md).
 *
 * One C program, four modes:
 *   full        bundle + pak → QuickJS guest → core → software raster
 *   native      MutationTape → core → DrawList → raster (no JS)
 *   raster      DrawListTape → raster
 *   guest-tape  bundle + tape → QuickJS guest with recorded native answers
 *
 * Two drivers for `full`: the case protocol (`--bench`, globalThis.__bench,
 * docs/PROTOCOL.md — the settle rule here is the harness's settleStep, line
 * for line) and the input tape (`--frames N --input "f:mask,..."`).
 *
 * Stage boundaries come from pocket_runtime.c's bench hooks (eval / js /
 * jobs / tick) and from this file (draw / render / verify); marks_host.c
 * turns them into thread CPU time, marks_so3.c into plugin markers. The
 * output is JSON lines (spec/protocol.ts ShellRecord).
 */

#include "pocket_core.h"
#include "pocket_runtime.h"
#include "pocket_spec.h"

#include "arena.h"
#include "generated/pocket_tape.h"
#include "jsglue.h"
#include "marks.h"
#include "pb.h"
#include "vtime.h"
#if defined(PB_OBSERVE)
#include "record.h"
#endif
#if defined(PB_GUEST_TAPE)
#include "tape_host.h"
#endif

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef PB_QUICKJS_VERSION
#define PB_QUICKJS_VERSION "unknown"
#endif
#ifndef PB_HOST_NAME
#define PB_HOST_NAME "host-shell"
#endif
#if defined(PB_OBSERVE)
#define PB_OBSERVER_NAME "observe"
#else
#define PB_OBSERVER_NAME "measure"
#endif

#define PB_MAX_TAPE 4096
#define PB_MAX_ACTIONS 64
#define PB_STABLE_FRAMES 2
#define PB_DEFAULT_MAX_SETTLE 120
#define PB_DEFAULT_WARMUP 1
#define PB_MOUNT_ACTION "mount"

typedef enum { MODE_FULL, MODE_GUEST_TAPE, MODE_NATIVE, MODE_RASTER } Mode;

typedef struct {
  unsigned long frame;
  uint32_t mask;
} TapeEntry;

typedef struct {
  Mode mode;
  const char *java_script;
  const char *pack;
  const char *tape;
  const char *dltape;
  const char *out;
  const char *record_tape;
  const char *record_dltape;
  const char *dump_fb;
  int bench;
  unsigned long frames;
  TapeEntry input[PB_MAX_TAPE];
  size_t input_length;
  const char *actions[PB_MAX_ACTIONS];
  size_t action_count;
  char *actions_buffer;
  uint32_t warmup;
  uint32_t max_settle;
  uint32_t run_id;
  uint32_t hz;
  int width;
  int height;
  uint64_t js_limit;
  uint64_t core_limit;
} Options;

typedef struct {
  uint32_t frames;
  uint32_t stable;
  int has_last;
  uint32_t last;
} Settle;

typedef struct {
  uint32_t fb_hash;
  uint64_t dl_hash;
  size_t dl_words;
} FrameOut;

static Options options;
static FILE *out;
static uint8_t *framebuffer;
static size_t framebuffer_length;
static uint32_t frame_counter;
static Settle settle;
static uint32_t *prev_words;
static size_t prev_words_length;
static uint32_t *cur_words;
static size_t cur_words_length;
static uint8_t *base_fb;
static size_t base_fb_length;
static uint64_t bundle_hash;
static uint64_t pak_hash;
static uint8_t *java_script_bytes;
static size_t java_script_length;
static uint8_t *pack_bytes;
static size_t pack_length;

static const char *const STAGE_NAMES[PB_STAGE_COUNT] = {
  "idle", "eval", "js", "jobs", "tick", "draw", "render", "verify",
};

/* ---- small helpers -------------------------------------------------------- */

static void usage(FILE *stream) {
  fputs(
    "usage: pocket-bench-shell --mode full|native|raster [--js app.js --pak app.pak]\n"
    "         [--tape in.pkmt] [--dltape in.pkdl] [--bench --actions a,b,c]\n"
    "         [--frames N --input \"f:mask,...\"] [--warmup K --max-settle M]\n"
    "         [--record-tape out.pkmt] [--record-dltape out.pkdl] [--out results.jsonl]\n"
    "         [--run-id N] [--hz 60 --width 480 --height 272] [--js-limit BYTES --core-limit BYTES]\n",
    stream
  );
}

static int read_file(const char *path, uint8_t **bytes, size_t *length) {
  FILE *file = fopen(path, "rb");
  long size;
  uint8_t *buffer;
  if (file == NULL) return 0;
  if (fseek(file, 0, SEEK_END) != 0 || (size = ftell(file)) < 0 || fseek(file, 0, SEEK_SET) != 0) {
    fclose(file);
    return 0;
  }
  buffer = (uint8_t *)malloc((size_t)size + 1);
  if (buffer == NULL) {
    fclose(file);
    return 0;
  }
  if (size > 0 && fread(buffer, 1, (size_t)size, file) != (size_t)size) {
    free(buffer);
    fclose(file);
    return 0;
  }
  fclose(file);
  buffer[size] = 0;
  *bytes = buffer;
  *length = (size_t)size;
  return 1;
}

static uint32_t fnv1a32(const uint8_t *bytes, size_t length) {
  uint32_t hash = 0x811c9dc5U;
  size_t i;
  for (i = 0; i < length; ++i) {
    hash ^= bytes[i];
    hash *= 0x01000193U;
  }
  return hash;
}

static uint64_t fnv1a64(const uint8_t *bytes, size_t length) {
  uint64_t hash = 0xcbf29ce484222325ULL;
  size_t i;
  for (i = 0; i < length; ++i) {
    hash ^= bytes[i];
    hash *= 0x00000100000001b3ULL;
  }
  return hash;
}

static void json_string(const char *text) {
  fputc('"', out);
  for (; *text != '\0'; ++text) {
    unsigned char c = (unsigned char)*text;
    if (c == '"' || c == '\\') {
      fputc('\\', out);
      fputc(c, out);
    } else if (c < 0x20) {
      fprintf(out, "\\u%04x", c);
    } else {
      fputc(c, out);
    }
  }
  fputc('"', out);
}

static void fail(int code, const char *message) {
  fprintf(stderr, "pocket-bench-shell: %s\n", message);
  if (out != NULL) {
    fprintf(out, "{\"kind\":\"end\",\"exit\":%d}\n", code);
    fflush(out);
  }
  exit(code);
}

static void fail_runtime(int code, const char *what) {
  fprintf(stderr, "pocket-bench-shell: %s: %s\n", what, pocket_runtime_error());
  if (out != NULL) {
    fprintf(out, "{\"kind\":\"end\",\"exit\":%d}\n", code);
    fflush(out);
  }
  exit(code);
}

/* ---- options -------------------------------------------------------------- */

static int parse_input(const char *script) {
  const char *cursor = script;
  while (*cursor != '\0') {
    char *end = NULL;
    unsigned long frame;
    unsigned long mask;
    if (options.input_length >= PB_MAX_TAPE) return 0;
    frame = strtoul(cursor, &end, 10);
    if (end == cursor || *end != ':') return 0;
    cursor = end + 1;
    mask = strtoul(cursor, &end, 0);
    if (end == cursor || (*end != ',' && *end != '\0')) return 0;
    if (options.input_length > 0 && frame < options.input[options.input_length - 1].frame) return 0;
    options.input[options.input_length].frame = frame;
    options.input[options.input_length].mask = (uint32_t)mask;
    options.input_length += 1;
    cursor = *end == ',' ? end + 1 : end;
  }
  return 1;
}

static int parse_actions(const char *list) {
  char *cursor;
  size_t length = strlen(list) + 1;
  options.actions_buffer = (char *)malloc(length);
  if (options.actions_buffer == NULL) return 0;
  memcpy(options.actions_buffer, list, length);
  cursor = options.actions_buffer;
  while (*cursor != '\0') {
    char *comma = strchr(cursor, ',');
    if (comma != NULL) *comma = '\0';
    if (*cursor != '\0') {
      if (options.action_count >= PB_MAX_ACTIONS) return 0;
      options.actions[options.action_count++] = cursor;
    }
    if (comma == NULL) break;
    cursor = comma + 1;
  }
  return 1;
}

static uint32_t mask_at(unsigned long frame) {
  uint32_t mask = 0;
  size_t i;
  for (i = 0; i < options.input_length; ++i) {
    if (options.input[i].frame > frame) break;
    mask = options.input[i].mask;
  }
  return mask;
}

static int parse_options(int argc, char **argv) {
  int i;
  memset(&options, 0, sizeof(options));
  options.mode = MODE_FULL;
  options.frames = 60;
  options.warmup = PB_DEFAULT_WARMUP;
  options.max_settle = PB_DEFAULT_MAX_SETTLE;
  options.hz = 60;
  options.width = 480;
  options.height = 272;
  for (i = 1; i < argc; ++i) {
    const char *argument = argv[i];
    const char *value = i + 1 < argc ? argv[i + 1] : NULL;
    if (strcmp(argument, "--help") == 0 || strcmp(argument, "-h") == 0) {
      usage(stdout);
      exit(0);
    }
    if (strcmp(argument, "--bench") == 0) {
      options.bench = 1;
      continue;
    }
    if (value == NULL) {
      fprintf(stderr, "pocket-bench-shell: %s needs a value\n", argument);
      return 0;
    }
    if (strcmp(argument, "--observer") == 0) {
      /* The observer is a build variant; the flag only checks the binary matches. */
      if (strcmp(value, PB_OBSERVER_NAME) != 0) {
        fprintf(stderr, "pocket-bench-shell: this binary is the %s build, not %s\n", PB_OBSERVER_NAME, value);
        return 0;
      }
    } else if (strcmp(argument, "--mode") == 0) {
      if (strcmp(value, "full") == 0) options.mode = MODE_FULL;
      else if (strcmp(value, "guest-tape") == 0) options.mode = MODE_GUEST_TAPE;
      else if (strcmp(value, "native") == 0) options.mode = MODE_NATIVE;
      else if (strcmp(value, "raster") == 0) options.mode = MODE_RASTER;
      else {
        fprintf(stderr, "pocket-bench-shell: unknown mode %s\n", value);
        return 0;
      }
    } else if (strcmp(argument, "--js") == 0) options.java_script = value;
    else if (strcmp(argument, "--pak") == 0) options.pack = value;
    else if (strcmp(argument, "--tape") == 0) options.tape = value;
    else if (strcmp(argument, "--dltape") == 0) options.dltape = value;
    else if (strcmp(argument, "--out") == 0) options.out = value;
    else if (strcmp(argument, "--record-tape") == 0) options.record_tape = value;
    else if (strcmp(argument, "--record-dltape") == 0) options.record_dltape = value;
    else if (strcmp(argument, "--dump-fb") == 0) options.dump_fb = value;
    else if (strcmp(argument, "--frames") == 0) options.frames = strtoul(value, NULL, 10);
    else if (strcmp(argument, "--warmup") == 0) options.warmup = (uint32_t)strtoul(value, NULL, 10);
    else if (strcmp(argument, "--max-settle") == 0) options.max_settle = (uint32_t)strtoul(value, NULL, 10);
    else if (strcmp(argument, "--run-id") == 0) options.run_id = (uint32_t)strtoul(value, NULL, 10);
    else if (strcmp(argument, "--hz") == 0) options.hz = (uint32_t)strtoul(value, NULL, 10);
    else if (strcmp(argument, "--width") == 0) options.width = atoi(value);
    else if (strcmp(argument, "--height") == 0) options.height = atoi(value);
    else if (strcmp(argument, "--js-limit") == 0) options.js_limit = strtoull(value, NULL, 10);
    else if (strcmp(argument, "--core-limit") == 0) options.core_limit = strtoull(value, NULL, 10);
    else if (strcmp(argument, "--input") == 0) {
      if (!parse_input(value)) {
        fprintf(stderr, "pocket-bench-shell: bad --input %s\n", value);
        return 0;
      }
    } else if (strcmp(argument, "--actions") == 0) {
      if (!parse_actions(value)) {
        fprintf(stderr, "pocket-bench-shell: bad --actions %s\n", value);
        return 0;
      }
    } else {
      fprintf(stderr, "pocket-bench-shell: unknown option %s\n", argument);
      return 0;
    }
    i += 1;
  }
  if (options.hz != 60) {
    fputs("pocket-bench-shell: only --hz 60 is supported (pocket_runtime_tick advances one core tick)\n", stderr);
    return 0;
  }
  if (options.width <= 0 || options.height <= 0) return 0;
  if (options.mode == MODE_FULL && (options.java_script == NULL || options.pack == NULL)) {
    fputs("pocket-bench-shell: --mode full needs --js and --pak\n", stderr);
    return 0;
  }
  if (options.mode == MODE_NATIVE && options.tape == NULL) {
    fputs("pocket-bench-shell: --mode native needs --tape\n", stderr);
    return 0;
  }
  if (options.mode == MODE_RASTER && options.dltape == NULL) {
    fputs("pocket-bench-shell: --mode raster needs --dltape\n", stderr);
    return 0;
  }
  return 1;
}

static int eval_int(const char *format, const char *action, int32_t *result);

/* Read globalThis.__bench.actions through the int32 eval hook, one code
 * unit at a time — a few dozen evals once per run, before any timing. */
static void bench_load_actions(void) {
  int32_t count = 0;
  int32_t i;
  size_t total = 0;
  size_t at = 0;
  if (!eval_int("globalThis.__bench.actions.length%s", "", &count)) fail_runtime(3, "__bench.actions");
  if (count <= 0 || count > PB_MAX_ACTIONS) fail(3, "__bench.actions is empty or too long");
  for (i = 0; i < count; ++i) {
    int32_t length = 0;
    char index[16];
    snprintf(index, sizeof(index), "%d", (int)i);
    if (!eval_int("globalThis.__bench.actions[%s].length", index, &length)) fail_runtime(3, "__bench.actions");
    if (length <= 0 || length > 128) fail(3, "an action name is empty or longer than 128");
    total += (size_t)length + 1;
  }
  options.actions_buffer = (char *)malloc(total);
  if (options.actions_buffer == NULL) fail(4, "out of memory");
  for (i = 0; i < count; ++i) {
    int32_t length = 0;
    int32_t j;
    char index[16];
    snprintf(index, sizeof(index), "%d", (int)i);
    eval_int("globalThis.__bench.actions[%s].length", index, &length);
    options.actions[options.action_count++] = options.actions_buffer + at;
    for (j = 0; j < length; ++j) {
      int32_t code = 0;
      char probe[48];
      snprintf(probe, sizeof(probe), "%d].charCodeAt(%d)", (int)i, (int)j);
      if (!eval_int("globalThis.__bench.actions[%s", probe, &code)) fail_runtime(3, "__bench.actions");
      if (code <= 0 || code > 126) fail(3, "action names must be printable ASCII");
      options.actions_buffer[at++] = (char)code;
    }
    options.actions_buffer[at++] = '\0';
  }
}

/* ---- output records ------------------------------------------------------- */

static void emit_identity(void) {
  size_t i;
  fprintf(
    out,
    "{\"kind\":\"identity\",\"host\":\"%s\",\"mode\":\"%s\",\"observer\":\"%s\",\"quickjs_version\":\"%s\","
    "\"run_id\":%u,\"hz\":%u,\"tick_hz\":60,\"viewport\":[%d,%d],\"pb_abi\":%u,\"op_caps\":[",
    PB_HOST_NAME,
    options.mode == MODE_FULL ? "full" : options.mode == MODE_NATIVE ? "native" : options.mode == MODE_RASTER ? "raster" : "guest-tape",
    PB_OBSERVER_NAME,
    PB_QUICKJS_VERSION,
    options.run_id,
    options.hz,
    options.width,
    options.height,
    pb_abi_version()
  );
  for (i = 0; i < PB_BOUND_OP_COUNT; ++i) {
    size_t j;
    for (j = 0; j < PB_OP_COUNT; ++j) {
      if (PB_OPS[j].op == PB_BOUND_OPS[i]) {
        fprintf(out, "%s\"%s\"", i == 0 ? "" : ",", PB_OPS[j].name);
        break;
      }
    }
  }
  fputs("],\"bundle_hash\":", out);
  if (options.java_script != NULL) fprintf(out, "\"%016llx\"", (unsigned long long)bundle_hash);
  else fputs("null", out);
  fputs(",\"pak_hash\":", out);
  if (options.pack != NULL) fprintf(out, "\"%016llx\"", (unsigned long long)pak_hash);
  else fputs("null", out);
  fputs("}\n", out);
}

static void emit_phase(const char *action, const char *iteration, long frame, int stage, uint64_t us) {
  fputs("{\"kind\":\"phase\",\"action\":", out);
  json_string(action);
  fprintf(out, ",\"iteration\":\"%s\",\"frame\":%ld,\"stage\":\"%s\",\"cpu_us\":%llu}\n", iteration, frame, STAGE_NAMES[stage], (unsigned long long)us);
}

static void emit_frame_phases(const char *action, const char *iteration, long frame) {
  static const int stages[5] = {PB_STAGE_JS, PB_STAGE_JOBS, PB_STAGE_TICK, PB_STAGE_DRAW, PB_STAGE_RENDER};
  int i;
  for (i = 0; i < 5; ++i) emit_phase(action, iteration, frame, stages[i], pb_marks_stage_us(stages[i]));
}

static void emit_action(
  const char *action,
  const char *iteration,
  int settled,
  uint32_t settle_frames,
  const FrameOut *last,
  uint32_t replay_mismatches
) {
  PbArenaStats js_arena;
  PbArenaStats core_arena;
  pb_arena_stats(PB_ARENA_QUICKJS, &js_arena);
  pb_arena_stats(PB_ARENA_CORE, &core_arena);
  fputs("{\"kind\":\"action\",\"action\":", out);
  json_string(action);
  fprintf(
    out,
    ",\"iteration\":\"%s\",\"settled\":%s,\"settle_frames\":%u,\"hashes\":{\"drawlist\":\"%016llx\",\"fb_rgba8\":\"%08lx\"},\"metrics\":{",
    iteration,
    settled ? "true" : "false",
    settle_frames,
    (unsigned long long)last->dl_hash,
    (unsigned long)last->fb_hash
  );
#if defined(PB_OBSERVE)
  {
    size_t i;
    int first = 1;
    fprintf(
      out,
      "\"hostops_total\":%llu,\"boundary_calls\":%llu,\"hostops_bytes\":%llu,\"text_bytes_crossing_boundary\":%llu,"
      "\"nodes_created\":%llu,\"nodes_destroyed\":%llu,\"hostops_by_type\":{",
      (unsigned long long)pb_record_total_calls(),
      (unsigned long long)pb_record_boundary_calls(),
      (unsigned long long)pb_record_total_bytes(),
      (unsigned long long)pb_record_text_bytes(),
      (unsigned long long)pb_record_nodes_created(),
      (unsigned long long)pb_record_nodes_destroyed()
    );
    for (i = 0; i < PB_OP_COUNT; ++i) {
      const PbOpCounter *counter = pb_record_counter(PB_OPS[i].op);
      if (counter == NULL || counter->calls == 0) continue;
      fprintf(out, "%s\"%s\":%llu", first ? "" : ",", PB_OPS[i].name, (unsigned long long)counter->calls);
      first = 0;
    }
    fputs("},", out);
  }
#endif
  fprintf(
    out,
    "\"jobs_count\":%llu,\"drawlist_words\":%zu,\"replay_mismatches\":%u,"
    "\"js_malloc_bytes\":%llu,\"js_malloc_count\":%llu,\"js_peak_bytes\":%llu,"
    "\"core_malloc_bytes\":%llu,\"core_peak_bytes\":%llu}}\n",
    (unsigned long long)pb_js_jobs_count(),
    last->dl_words,
    replay_mismatches,
    (unsigned long long)js_arena.current_bytes,
    (unsigned long long)js_arena.allocations,
    (unsigned long long)js_arena.peak_bytes,
    (unsigned long long)core_arena.current_bytes,
    (unsigned long long)core_arena.peak_bytes
  );
}

/* ---- guest protocol helpers ---------------------------------------------- */

static int eval_int(const char *format, const char *action, int32_t *result) {
  char source[512];
  int written = snprintf(source, sizeof(source), format, action);
  if (written < 0 || written >= (int)sizeof(source)) fail(1, "action name too long");
  return pocket_runtime_eval_int32(source, (size_t)written, result);
}

static void bench_run(const char *action) {
  if (!eval_int("globalThis.__bench.run(\"%s\"), 0", action, NULL)) fail_runtime(3, "__bench.run");
}

static int bench_post(const char *action) {
  int32_t value = 0;
  if (!eval_int("globalThis.__bench.post(\"%s\") ? 1 : 0", action, &value)) fail_runtime(3, "__bench.post");
  return value != 0;
}

static int bench_has_reset(void) {
  int32_t value = 0;
  if (!eval_int("typeof globalThis.__bench%s.reset === \"function\" ? 1 : 0", "", &value)) fail_runtime(3, "__bench.reset");
  return value != 0;
}

static void bench_reset(void) {
  if (!eval_int("globalThis.__bench%s.reset(), 0", "", NULL)) fail_runtime(3, "__bench.reset");
}

static void bench_check(void) {
  int32_t value = 0;
  if (!eval_int("(globalThis.__bench && globalThis.__bench.version === 1) ? 1 : 0", "", &value)) fail_runtime(3, "__bench");
  if (!value) fail(3, "bundle did not install globalThis.__bench v1 (docs/PROTOCOL.md)");
  if (options.action_count == 0) {
    bench_load_actions();
  } else {
    char joined[2048];
    size_t i;
    size_t at = 0;
    joined[0] = '\0';
    for (i = 0; i < options.action_count; ++i) {
      int written = snprintf(joined + at, sizeof(joined) - at, "%s%s", i == 0 ? "" : ",", options.actions[i]);
      if (written < 0 || (size_t)written >= sizeof(joined) - at) fail(1, "--actions too long");
      at += (size_t)written;
    }
    if (!eval_int("globalThis.__bench.actions.join(\",\") === \"%s\" ? 1 : 0", joined, &value)) fail_runtime(3, "__bench.actions");
    if (!value) fail(3, "--actions does not match globalThis.__bench.actions");
  }
  if (options.warmup > 0 && !bench_has_reset()) fail(3, "warmup > 0 but __bench has no reset()");
}

/* ---- settle rule (harness/lib.ts settleStep, line for line) --------------- */

typedef enum { SETTLE_CONTINUE, SETTLE_SETTLED, SETTLE_EXHAUSTED } Verdict;

static void settle_begin(void) {
  settle.frames = 0;
  settle.stable = 0;
}

static Verdict settle_step(int post, uint32_t fb_hash) {
  settle.frames += 1;
  if (post) {
    settle.last = fb_hash;
    settle.has_last = 1;
    settle.stable = 0;
    return SETTLE_SETTLED;
  }
  if (settle.has_last && fb_hash == settle.last) settle.stable += 1;
  else settle.stable = 0;
  settle.last = fb_hash;
  settle.has_last = 1;
  if (settle.stable >= PB_STABLE_FRAMES) return SETTLE_SETTLED;
  if (settle.frames >= options.max_settle) return SETTLE_EXHAUSTED;
  return SETTLE_CONTINUE;
}

/* ---- frames ---------------------------------------------------------------- */

static void keep_words(const uint32_t *words, size_t length) {
  uint32_t *swap = prev_words;
  size_t swap_length = prev_words_length;
  prev_words = cur_words;
  prev_words_length = cur_words_length;
  cur_words = swap;
  if (cur_words == NULL || swap_length < length) {
    uint32_t *grown = (uint32_t *)realloc(cur_words, (length == 0 ? 1 : length) * sizeof(uint32_t));
    if (grown == NULL) fail(4, "out of memory");
    cur_words = grown;
  }
  memcpy(cur_words, words, length * sizeof(uint32_t));
  cur_words_length = length;
}

/* draw + render + hash; the caller has already run js / jobs / tick. */
static void finish_frame(FrameOut *result) {
  const uint32_t *words = NULL;
  size_t length = 0;
  pb_marks_stage(PB_STAGE_DRAW);
  if (pb_draw(&words, &length) != 0) fail(3, "pb_draw failed");
  pb_marks_stage(PB_STAGE_RENDER);
  if (options.record_dltape != NULL) {
    /* The framebuffer as it stands is the accumulated history the recorded
     * frame will blend over — the DrawListTape's base. */
    if (base_fb == NULL) {
      base_fb = (uint8_t *)malloc(framebuffer_length == 0 ? 1 : framebuffer_length);
      if (base_fb == NULL) fail(4, "out of memory");
    }
    memcpy(base_fb, framebuffer, framebuffer_length);
    base_fb_length = framebuffer_length;
  }
  if (pb_render_rgba8(words, length, framebuffer, framebuffer_length, 1) != 0) fail(3, "pb_render_rgba8 failed");
  pb_marks_stage(PB_STAGE_VERIFY);
  result->fb_hash = fnv1a32(framebuffer, framebuffer_length);
  result->dl_hash = pb_words_hash(words, length);
  result->dl_words = length;
  if (options.record_dltape != NULL) keep_words(words, length);
}

/* One guest frame: optional run() (js), frame() + jobs + tick (runtime hooks), draw, render. */
static void run_guest_frame(uint32_t buttons, const char *run_action, FrameOut *result) {
  PocketRuntimeInput input;
  pb_marks_begin_frame(frame_counter);
  pb_vtime_set_frame(frame_counter);
#if defined(PB_OBSERVE)
  pb_record_frame(frame_counter, buttons, (uint32_t)POCKET_ANALOG_CENTER, 1);
#endif
  if (run_action != NULL) {
    pb_marks_stage(PB_STAGE_JS);
    bench_run(run_action);
  }
  input.buttons = buttons;
  input.touch_down = 0;
  input.touch_x = 0;
  input.touch_y = 0;
  input.touch_hit = 0;
  if (!pocket_runtime_tick(&input)) fail_runtime(3, "frame");
  finish_frame(result);
  frame_counter += 1;
}

static void reset_action_counters(void) {
#if defined(PB_OBSERVE)
  pb_record_reset_counters();
#endif
  pb_js_jobs_reset();
}

/* The protocol's settle(): frames until post() or the hash rule says so. */
static void run_action(const char *action, const char *iteration, int do_run) {
  FrameOut result;
  int settled = 0;
  uint32_t frame_in_action = 0;
  settle_begin();
  if (strcmp(action, PB_MOUNT_ACTION) != 0) reset_action_counters();
#if defined(PB_OBSERVE)
  if (do_run) {
    pb_record_action(
      action,
      strcmp(iteration, "steady") == 0 ? PB_ACTION_STEADY
      : strcmp(iteration, "warmup") == 0 ? PB_ACTION_WARMUP
                                         : PB_ACTION_FIRST
    );
  }
#endif
  memset(&result, 0, sizeof(result));
  for (;;) {
    Verdict verdict;
    run_guest_frame(0, do_run && frame_in_action == 0 ? action : NULL, &result);
    verdict = settle_step(bench_post(action), result.fb_hash);
    pb_marks_stage(PB_STAGE_IDLE);
    emit_frame_phases(action, iteration, (long)frame_in_action);
    frame_in_action += 1;
    if (verdict == SETTLE_SETTLED) {
      settled = 1;
      break;
    }
    if (verdict == SETTLE_EXHAUSTED) break;
  }
  emit_action(action, iteration, settled, settle.frames, &result, 0);
}

static void write_dltape(const FrameOut *last) {
  uint32_t header[PB_DL_FIXED_WORDS];
  uint64_t rgba_hash = fnv1a64(framebuffer, framebuffer_length);
  FILE *file;
  (void)last;
  memset(header, 0, sizeof(header));
  header[PB_DL_MAGIC] = PB_DRAWLIST_TAPE_MAGIC;
  header[PB_DL_VERSION] = PB_TAPE_VERSION;
  header[PB_DL_HEADER_WORDS] = PB_DL_FIXED_WORDS;
  header[PB_DL_SOURCE] = PB_SOURCE_SHELL_RECORDING;
  header[PB_DL_VIEWPORT_W] = (uint32_t)options.width;
  header[PB_DL_VIEWPORT_H] = (uint32_t)options.height;
  header[PB_DL_RASTER_DENSITY] = 1;
  header[PB_DL_PIXEL_FORMAT] = PB_PIXEL_RGBA8;
  header[PB_DL_DAMAGE_MAX_REGIONS] = 0;
  header[PB_DL_WARMUP_FRAMES] = prev_words == NULL ? 0 : 1;
  header[PB_DL_EXPECTED_FB_HASH_RGBA8] = (uint32_t)(rgba_hash & 0xffffffffULL);
  header[PB_DL_EXPECTED_FB_HASH_RGBA8 + 1] = (uint32_t)(rgba_hash >> 32);
  header[PB_DL_PREV_WORDS] = (uint32_t)prev_words_length;
  header[PB_DL_CUR_WORDS] = (uint32_t)cur_words_length;
  header[PB_DL_BASE_FB_WORDS] = (uint32_t)(base_fb_length / 4);
  header[PB_DL_ATLAS_COUNT] = 0;
  file = fopen(options.record_dltape, "wb");
  if (file == NULL) fail(4, "cannot write --record-dltape");
  if (fwrite(header, sizeof(uint32_t), PB_DL_FIXED_WORDS, file) != PB_DL_FIXED_WORDS ||
      (prev_words_length > 0 && fwrite(prev_words, sizeof(uint32_t), prev_words_length, file) != prev_words_length) ||
      (cur_words_length > 0 && fwrite(cur_words, sizeof(uint32_t), cur_words_length, file) != cur_words_length) ||
      (base_fb_length > 0 && fwrite(base_fb, 1, base_fb_length, file) != base_fb_length)) {
    fclose(file);
    fail(4, "short write to --record-dltape");
  }
  fclose(file);
}

/* ---- mode: full ------------------------------------------------------------ */

static void boot_guest(void) {
  if (!read_file(options.java_script, &java_script_bytes, &java_script_length)) fail(4, "cannot read --js");
  if (!read_file(options.pack, &pack_bytes, &pack_length)) fail(4, "cannot read --pak");
  bundle_hash = fnv1a64(java_script_bytes, java_script_length);
  pak_hash = fnv1a64(pack_bytes, pack_length);
  pb_vtime_set_hz(options.hz);
  pb_vtime_set_frame(0);
#if defined(PB_OBSERVE)
  if (options.record_tape != NULL && pb_record_arm() != 0) fail(4, "cannot arm the tape recorder");
#endif
  pb_marks_begin_frame(0);
  if (!pocket_runtime_boot(
        (const char *)java_script_bytes,
        java_script_length,
        pack_bytes,
        pack_length,
        options.width,
        options.height
      )) {
    fail_runtime(2, "boot failed");
  }
#if !defined(PB_GUEST_TAPE)
  if (pb_set_tick_rate(options.hz) != 0) fail(3, "core rejected --hz");
#endif
  pb_marks_stage(PB_STAGE_IDLE);
#if !defined(PB_GUEST_TAPE)
  /* The guest-tape build never rasterizes; touching the core would even
   * create the Ui singleton this build exists to keep out of the picture. */
  framebuffer_length = pb_framebuffer_len(1);
  framebuffer = (uint8_t *)malloc(framebuffer_length == 0 ? 1 : framebuffer_length);
  if (framebuffer == NULL) fail(4, "out of memory");
#endif
  emit_identity();
  emit_phase(PB_MOUNT_ACTION, "first", -1, PB_STAGE_EVAL, pb_marks_stage_us(PB_STAGE_EVAL));
}

#if defined(PB_GUEST_TAPE)
/* Guest only, queries answered from the tape, every call lockstep-matched. */
static void run_guest_tape(void) {
  uint32_t frame_index;
  uint32_t buttons;
  uint32_t ticks;
  uint32_t frames = 0;
  FrameOut result;
  if (options.tape == NULL) fail(1, "--mode guest-tape needs --tape");
  pb_tape_open(options.tape);
  boot_guest(); /* the recording's eval-period ops are matched during boot */
  char pending_action[128];
  pending_action[0] = '\0';
  for (;;) {
    PocketRuntimeInput input;
    PbTapeEvent event;
    if (!pb_tape_next(&event)) break;
    if (event.kind == PB_RECORD_ACTION) {
      /* The recording wrote ACTION, then the frame's FRAME record, then the
       * ops run() caused. Stash the name and re-issue run() right after the
       * FRAME record is consumed, so the ops land where the tape has them. */
      memcpy(pending_action, event.action, sizeof(pending_action));
      continue;
    }
    frame_index = event.frame_index;
    buttons = event.buttons;
    ticks = event.ticks;
    (void)frame_index;
    (void)ticks;
    pb_marks_begin_frame(frame_counter);
    pb_vtime_set_frame(frame_counter);
    if (pending_action[0] != '\0') {
      pb_marks_stage(PB_STAGE_JS);
      bench_run(pending_action);
      pending_action[0] = '\0';
    }
    input.buttons = buttons;
    input.touch_down = 0;
    input.touch_x = 0;
    input.touch_y = 0;
    input.touch_hit = 0;
    if (!pocket_runtime_tick(&input)) fail_runtime(3, "frame");
    pb_marks_stage(PB_STAGE_IDLE);
    emit_phase("tape", "first", (long)frames, PB_STAGE_JS, pb_marks_stage_us(PB_STAGE_JS));
    emit_phase("tape", "first", (long)frames, PB_STAGE_JOBS, pb_marks_stage_us(PB_STAGE_JOBS));
    frames += 1;
    frame_counter += 1;
  }
  memset(&result, 0, sizeof(result));
  emit_action("tape", "first", 1, frames, &result, 0);
  fprintf(
    stderr,
    "pocket-bench-shell: guest-tape lockstep ok — %llu ops, %u frames\n",
    (unsigned long long)pb_tape_matched_ops(),
    frames
  );
}
#endif

static void run_full_bench(void) {
  uint32_t k;
  size_t i;
  int has_reset;
  bench_check();
  has_reset = bench_has_reset();
  run_action(PB_MOUNT_ACTION, "first", 0);
  for (k = 0; k < options.warmup; ++k) {
    for (i = 0; i < options.action_count; ++i) run_action(options.actions[i], "warmup", 1);
    bench_reset();
  }
  for (i = 0; i < options.action_count; ++i) run_action(options.actions[i], "first", 1);
  if (has_reset) {
    for (i = 0; i < options.action_count; ++i) run_action(options.actions[i], "steady", 1);
  }
}

static void run_full_tape(void) {
  FrameOut result;
  unsigned long frame;
  memset(&result, 0, sizeof(result));
  for (frame = 0; frame < options.frames; ++frame) {
    run_guest_frame(mask_at(frame), NULL, &result);
    emit_frame_phases("tape", "first", (long)frame);
    pb_marks_stage(PB_STAGE_IDLE);
  }
  emit_action("tape", "first", 1, (uint32_t)options.frames, &result, 0);
  if (options.record_dltape != NULL) write_dltape(&result);
}

static void finish_recording(void) {
#if defined(PB_OBSERVE)
  if (options.record_tape != NULL) {
    PbTapeIdentity identity;
    memset(&identity, 0, sizeof(identity));
    identity.host_abi = 0;
    identity.source = PB_SOURCE_SHELL_RECORDING;
    identity.framework = PB_FRAMEWORK_NONE; /* the harness knows the framework; the tape carries the bundle hash */
    identity.viewport_w = (uint32_t)options.width;
    identity.viewport_h = (uint32_t)options.height;
    identity.raster_density = 1;
    identity.sim_hz = options.hz;
    identity.tick_hz = 60;
    identity.bundle_hash = bundle_hash;
    identity.pak_hash = pak_hash;
    if (pb_record_finish(options.record_tape, &identity) != 0) fail(4, "cannot write --record-tape");
  }
#endif
}

/* --dump-fb: write the final RGBA framebuffer for offline comparison. */
static void dump_framebuffer(void) {
  FILE *file;
  if (options.dump_fb == NULL || framebuffer == NULL) return;
  file = fopen(options.dump_fb, "wb");
  if (file == NULL) fail(4, "cannot write --dump-fb");
  if (fwrite(framebuffer, 1, framebuffer_length, file) != framebuffer_length) {
    fclose(file);
    fail(4, "short write to --dump-fb");
  }
  fclose(file);
}

/* Feed --pak's styles / atlases / textures to the core (native and raster
 * modes; the tape has the mutations, the pak has the assets they assume). */
static void load_assets_pak(void) {
#if defined(PB_GUEST_TAPE)
  return; /* the core does not exist in this build */
#else
  int32_t fed;
  if (options.pack == NULL) return;
  if (!read_file(options.pack, &pack_bytes, &pack_length)) fail(4, "cannot read --pak");
  fed = pb_load_pak(pack_bytes, pack_length);
  if (fed < 0) fail(5, "--pak is not a PocketJS pak");
  fprintf(stderr, "pocket-bench-shell: pak fed %d entr%s to the core\n", (int)fed, fed == 1 ? "y" : "ies");
#endif
}

/* ---- mode: native ----------------------------------------------------------- */

static void run_native(void) {
  uint8_t *tape = NULL;
  size_t tape_length = 0;
  PbTapeInfo info;
  PbFrame frame;
  FrameOut result;
  int32_t status;
  uint32_t frames = 0;
  if (!read_file(options.tape, &tape, &tape_length)) fail(4, "cannot read --tape");
  status = pb_replay_open(tape, tape_length);
  if (status != 0) {
    fprintf(stderr, "pocket-bench-shell: pb_replay_open failed (%d)\n", (int)status);
    fail(5, "tape rejected");
  }
  pb_replay_info(&info);
  ui_init(info.raster_density == 0 ? 1 : info.raster_density);
  ui_set_viewport((float)(info.viewport_w == 0 ? (uint32_t)options.width : info.viewport_w),
                  (float)(info.viewport_h == 0 ? (uint32_t)options.height : info.viewport_h));
  if (pb_set_tick_rate(info.tick_hz == 0 ? options.hz : info.tick_hz) != 0) fail(3, "core rejected tape tick rate");
  load_assets_pak();
  framebuffer_length = pb_framebuffer_len(1);
  framebuffer = (uint8_t *)malloc(framebuffer_length == 0 ? 1 : framebuffer_length);
  if (framebuffer == NULL) fail(4, "out of memory");
  emit_identity();
  memset(&result, 0, sizeof(result));
  for (;;) {
    pb_marks_begin_frame(frame_counter);
    /* The op application is core work with no JS behind it; it is reported
     * under `js` so the six stages keep their meaning across modes. */
    pb_marks_stage(PB_STAGE_JS);
    status = pb_replay_next(&frame);
    if (status < 0) {
      fprintf(stderr, "pocket-bench-shell: pb_replay_next failed (%d) at frame %u\n", (int)status, frames);
      fail(5, "tape replay failed");
    }
    if (status == 0) {
      /* EOF was detected under the JS marker set above; close the stage so
       * everything after the replay (action output, process exit, whatever
       * the OS runs next) lands in idle, not in (js, last frame). */
      pb_marks_stage(PB_STAGE_IDLE);
      break;
    }
    if (frame.frame_index == 0xFFFFFFFFU) {
      /* The eval segment: the ops a recording made before its first frame. */
      pb_marks_stage(PB_STAGE_IDLE);
      emit_phase("tape", "first", -1, PB_STAGE_EVAL, pb_marks_stage_us(PB_STAGE_JS));
      continue;
    }
    pb_marks_stage(PB_STAGE_TICK);
    pb_tick(frame.ticks);
    finish_frame(&result);
    pb_marks_stage(PB_STAGE_IDLE);
    emit_frame_phases("tape", "first", (long)frames);
    frames += 1;
    frame_counter += 1;
  }
  emit_action("tape", "first", 1, frames, &result, pb_replay_mismatches());
  if (options.record_dltape != NULL) write_dltape(&result);
  dump_framebuffer();
  pb_replay_close();
  free(tape);
}

/* ---- mode: raster ------------------------------------------------------------ */

static void run_raster(void) {
  uint8_t *tape = NULL;
  size_t tape_length = 0;
  const uint32_t *words;
  uint32_t header_words;
  uint32_t prev_count;
  uint32_t cur_count;
  uint32_t base_count;
  const uint32_t *prev;
  const uint32_t *cur;
  const uint8_t *base;
  FrameOut result;
  unsigned long frame;
  if (!read_file(options.dltape, &tape, &tape_length)) fail(4, "cannot read --dltape");
  if (tape_length < PB_DL_FIXED_WORDS * 4 || tape_length % 4 != 0) fail(5, "dltape truncated");
  words = (const uint32_t *)tape;
  if (words[PB_DL_MAGIC] != PB_DRAWLIST_TAPE_MAGIC) fail(5, "dltape magic mismatch");
  if (words[PB_DL_VERSION] != PB_TAPE_VERSION) fail(5, "dltape version mismatch");
  header_words = words[PB_DL_HEADER_WORDS];
  prev_count = words[PB_DL_PREV_WORDS];
  cur_count = words[PB_DL_CUR_WORDS];
  base_count = words[PB_DL_BASE_FB_WORDS];
  if ((size_t)header_words + prev_count + cur_count + base_count > tape_length / 4) fail(5, "dltape truncated");
  prev = words + header_words;
  cur = prev + prev_count;
  base = (const uint8_t *)(cur + cur_count);
  ui_init(words[PB_DL_RASTER_DENSITY] == 0 ? 1 : words[PB_DL_RASTER_DENSITY]);
  ui_set_viewport((float)words[PB_DL_VIEWPORT_W], (float)words[PB_DL_VIEWPORT_H]);
  if (pb_set_tick_rate(options.hz) != 0) fail(3, "core rejected --hz");
  /* Assets: replaying the MutationTape the DrawList came from reproduces the
   * exact texture handles and atlas slots (same ops, fresh core); --pak is
   * the looser fallback (pak order may differ from the guest's uploads). */
  if (options.tape != NULL) {
    uint8_t *mutation_tape = NULL;
    size_t mutation_tape_length = 0;
    PbFrame asset_frame;
    int32_t status;
    uint32_t applied;
    if (!read_file(options.tape, &mutation_tape, &mutation_tape_length)) fail(4, "cannot read --tape");
    status = pb_replay_open(mutation_tape, mutation_tape_length);
    if (status != 0) fail(5, "asset tape rejected");
    for (;;) {
      status = pb_replay_next(&asset_frame);
      if (status < 0) fail(5, "asset tape replay failed");
      if (status == 0) break;
      if (asset_frame.frame_index != 0xFFFFFFFFU) pb_tick(asset_frame.ticks);
    }
    applied = pb_replay_ops_applied();
    pb_replay_close();
    free(mutation_tape);
    {
      /* One untimed draw: the core materializes draw-time resources (atlas
       * pages, gradient textures) that the recorded DrawList references but
       * no op creates; without it those quads rasterize as nothing. */
      const uint32_t *materialize_words = NULL;
      size_t materialize_length = 0;
      pb_draw(&materialize_words, &materialize_length);
    }
    fprintf(stderr, "pocket-bench-shell: assets reconstructed from --tape (%u ops)\n", applied);
  } else {
    load_assets_pak();
  }
  framebuffer_length = pb_framebuffer_len(1);
  framebuffer = (uint8_t *)malloc(framebuffer_length == 0 ? 1 : framebuffer_length);
  if (framebuffer == NULL) fail(4, "out of memory");
  emit_identity();
  memset(&result, 0, sizeof(result));
  for (frame = 0; frame < options.frames; ++frame) {
    /* Every iteration renders the recorded frame over the state it really
     * had: translucent ops blend into the destination, so rendering the same
     * words twice over the result is a different picture. Restoring the base
     * (or re-rendering the previous list) happens outside the timed stage. */
    if (base_count > 0 && base_count * 4 == framebuffer_length) {
      memcpy(framebuffer, base, framebuffer_length);
    } else if (prev_count > 0) {
      pb_render_rgba8(prev, prev_count, framebuffer, framebuffer_length, 1);
    } else {
      memset(framebuffer, 0, framebuffer_length);
    }
    pb_marks_begin_frame(frame_counter);
    pb_marks_stage(PB_STAGE_RENDER);
    if (pb_render_rgba8(cur, cur_count, framebuffer, framebuffer_length, 1) != 0) fail(3, "pb_render_rgba8 failed");
    pb_marks_stage(PB_STAGE_VERIFY);
    result.fb_hash = fnv1a32(framebuffer, framebuffer_length);
    result.dl_hash = pb_words_hash(cur, cur_count);
    result.dl_words = cur_count;
    pb_marks_stage(PB_STAGE_IDLE);
    emit_phase("tape", "first", (long)frame, PB_STAGE_RENDER, pb_marks_stage_us(PB_STAGE_RENDER));
    frame_counter += 1;
  }
  emit_action("tape", "first", 1, (uint32_t)options.frames, &result, 0);
  dump_framebuffer();
  free(tape);
}

/* ---- main ------------------------------------------------------------------- */

int main(int argc, char **argv) {
  if (!parse_options(argc, argv)) {
    usage(stderr);
    return 1;
  }
  if (pb_abi_version() != PB_ABI_VERSION) {
    fprintf(stderr, "pocket-bench-shell: pocket-bench ABI %u, shell expects %u\n", pb_abi_version(), PB_ABI_VERSION);
    return 1;
  }
  out = stdout;
  if (options.out != NULL && strcmp(options.out, "-") != 0) {
    out = fopen(options.out, "w");
    if (out == NULL) {
      fprintf(stderr, "pocket-bench-shell: cannot write %s: %s\n", options.out, strerror(errno));
      return 4;
    }
  }
  if (options.js_limit != 0) pb_arena_set_limit(PB_ARENA_QUICKJS, options.js_limit);
  if (options.core_limit != 0) pb_arena_set_limit(PB_ARENA_CORE, options.core_limit);
  pb_marks_begin_run(options.run_id);

#if defined(PB_GUEST_TAPE)
  if (options.mode != MODE_GUEST_TAPE) {
    fail(1, "this binary is the guest-tape build; it only runs --mode guest-tape");
  }
  run_guest_tape();
  pocket_runtime_shutdown();
#else
  switch (options.mode) {
    case MODE_FULL:
      boot_guest();
      if (options.bench) run_full_bench();
      else run_full_tape();
      finish_recording();
      pocket_runtime_shutdown();
      break;
    case MODE_NATIVE:
      run_native();
      break;
    case MODE_RASTER:
      run_raster();
      break;
    case MODE_GUEST_TAPE:
      fail(1, "--mode guest-tape runs on the pocket-bench-shell-guest binary");
      break;
  }
#endif
  fputs("{\"kind\":\"end\",\"exit\":0}\n", out);
  if (out != stdout) fclose(out);
  free(framebuffer);
  free(prev_words);
  free(cur_words);
  free(java_script_bytes);
  free(pack_bytes);
  free(options.actions_buffer);
  return 0;
}
