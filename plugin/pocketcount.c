/*
 * plugin/pocketcount.c — QEMU TCG plugin: count guest instructions and memory
 * accesses by (run, segment, stage, frame) for the PocketJS bench shell.
 *
 *   -plugin ./libpocketcount.so,segmap=<file>,out=<json>[,observe=1]
 *
 * segment: which part of the binary the instruction's PC belongs to
 *          (quickjs / core / raster / libc / shell / kernel / other), from a
 *          segmap file of `<start_hex> <end_hex> <name>` lines plus an optional
 *          `kernel <hex>` threshold line (PC >= threshold is the kernel).
 * stage:   set by the shell through a marker instruction (docs/SHELL.md):
 *          0 idle 1 eval 2 js 3 jobs 4 tick 5 draw 6 render 7 verify.
 * frame:   the virtual frame index carried by the same marker.
 * run:     special stage 8 carries a logical run id in the frame register;
 *          normal stage markers may then restart at frame 0 without collision.
 *
 * Marker protocol (zero cost on real hardware, independent of the guest OS):
 * a register-to-itself move the compiler never emits on its own, executed
 * with a magic value in the third argument register —
 *   AArch64  orr x1, x1, x1     encoding 0xAA010021
 *   A32      mov r1, r1         encoding 0xE1A01001
 *   T32      mov r1, r1         encoding 0x4609 (16-bit)
 * At execution x3/r3 == 0x504B4D4B ("KMKP"), x1/r1 == stage id, x2/r2 ==
 * frame index. The plugin matches the instruction bytes at translation time
 * and registers an execution callback that reads the registers; a match with
 * the wrong magic is ignored, so an accidental encoding elsewhere is harmless.
 *
 * Instruction counting is inline (qemu_plugin_register_vcpu_insn_exec_inline_
 * per_vcpu) into one scoreboard counter PER SEGMENT — the segment is known at
 * translation time, the stage is not. The stage split comes from the marker
 * callback: at every stage change it reads each segment's running total,
 * attributes the delta since the previous marker to the stage that was active,
 * and snapshots the totals. That is exact for a single vCPU executing markers
 * in program order (the bench runs -smp 1), and it keeps the hot path inline.
 * Memory accesses need their size, so they use a plain callback per access;
 * plugin callbacks slow QEMU down but never change the guest's instruction
 * count under -icount, which is the only thing this plugin reports.
 *
 * Build: see the top-level CMake project (needs qemu-plugin.h of the pinned QEMU;
 * qemu_plugin_read_register needs QEMU >= 9.0, the copying
 * qemu_plugin_insn_data needs >= 9.1). Validated on QEMU 10.0.11 for
 * aarch64, A32, Thumb and SO3 EL0; see README.md.
 */

#include <glib.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <qemu-plugin.h>

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

#define MAX_SEGMENTS 16
#define NSTAGES 8
#define RUN_MARKER_STAGE NSTAGES
#define MARKER_MAGIC 0x504B4D4BULL
#define MAX_FRAMES (1u << 20)
#define MAX_RUNS (1u << 16)

typedef struct {
  uint64_t insns;
  uint64_t loads;
  uint64_t stores;
  uint64_t load_bytes;
  uint64_t store_bytes;
} Counts;

typedef struct {
  uint64_t start;
  uint64_t end; /* exclusive */
  int segment;
} Range;

/* One scoreboard entry per vCPU: the inline instruction counter per segment. */
typedef struct {
  uint64_t insns[MAX_SEGMENTS];
} Score;

typedef struct {
  Counts c[MAX_SEGMENTS][NSTAGES];
  int used;
} FrameCounts;

typedef struct {
  Counts c[MAX_SEGMENTS][NSTAGES];
  FrameCounts *frames;
  size_t frames_cap;
  uint64_t max_frame;
  int used;
} RunCounts;

typedef struct {
  uint64_t start_line;
  uint64_t end_line;
} TbLines;

typedef struct {
  uint64_t *keys;
  size_t cap;
  size_t count;
} LineSet;

enum { ARCH_UNKNOWN, ARCH_AARCH64, ARCH_ARM };

static const char *const STAGE_NAMES[NSTAGES] = {
  "idle", "eval", "js", "jobs", "tick", "draw", "render", "verify",
};

static char *segment_names[MAX_SEGMENTS];
static int nsegments;
static int kernel_segment = -1;
static uint64_t kernel_base;
static int have_kernel_base;
static Range *ranges;
static size_t nranges;

static struct qemu_plugin_scoreboard *score;
static uint64_t last_insns[MAX_SEGMENTS];
static Counts acc[MAX_SEGMENTS][NSTAGES];
static FrameCounts *frames;
static size_t frames_cap;
static uint64_t max_frame;
static RunCounts *runs;
static size_t runs_cap;
static int cur_stage;
static uint64_t cur_frame;
static uint64_t cur_run;
static uint64_t marker_hits;
static uint64_t marker_misses;

static int arch = ARCH_UNKNOWN;
static char *out_path;
static int observe;

static struct qemu_plugin_register *payload_regs[3]; /* stage, frame, magic */
static GByteArray *reg_buf;

static LineSet code_lines;
static LineSet data_lines;

/* ---- small open-addressing set for 64-bit line numbers -------------------- */

#define LINESET_EMPTY UINT64_MAX

static void lineset_init(LineSet *set) {
  set->cap = 1u << 16;
  set->count = 0;
  set->keys = g_malloc(set->cap * sizeof(uint64_t));
  for (size_t i = 0; i < set->cap; i++) set->keys[i] = LINESET_EMPTY;
}

static uint64_t mix64(uint64_t x) {
  x ^= x >> 33;
  x *= 0xff51afd7ed558ccdULL;
  x ^= x >> 33;
  x *= 0xc4ceb9fe1a85ec53ULL;
  x ^= x >> 33;
  return x;
}

static void lineset_grow(LineSet *set);

static int lineset_add(LineSet *set, uint64_t key) {
  if (key == LINESET_EMPTY) return 0;
  if (set->count * 2 >= set->cap) lineset_grow(set);
  size_t mask = set->cap - 1;
  size_t i = (size_t)mix64(key) & mask;
  for (;;) {
    if (set->keys[i] == key) return 0;
    if (set->keys[i] == LINESET_EMPTY) {
      set->keys[i] = key;
      set->count += 1;
      return 1;
    }
    i = (i + 1) & mask;
  }
}

static void lineset_grow(LineSet *set) {
  LineSet bigger;
  bigger.cap = set->cap * 2;
  bigger.count = 0;
  bigger.keys = g_malloc(bigger.cap * sizeof(uint64_t));
  for (size_t i = 0; i < bigger.cap; i++) bigger.keys[i] = LINESET_EMPTY;
  for (size_t i = 0; i < set->cap; i++) {
    if (set->keys[i] != LINESET_EMPTY) lineset_add(&bigger, set->keys[i]);
  }
  g_free(set->keys);
  *set = bigger;
}

/* ---- segments ------------------------------------------------------------- */

static int segment_index(const char *name) {
  for (int i = 0; i < nsegments; i++) {
    if (strcmp(segment_names[i], name) == 0) return i;
  }
  if (nsegments >= MAX_SEGMENTS) {
    fprintf(stderr, "pocketcount: too many segments (max %d), '%s' folded into other\n", MAX_SEGMENTS, name);
    return 0;
  }
  segment_names[nsegments] = g_strdup(name);
  return nsegments++;
}

static int range_compare(const void *a, const void *b) {
  const Range *ra = a;
  const Range *rb = b;
  return ra->start < rb->start ? -1 : ra->start > rb->start ? 1 : 0;
}

static int load_segmap(const char *path) {
  FILE *file = fopen(path, "r");
  if (file == NULL) {
    fprintf(stderr, "pocketcount: cannot open segmap %s\n", path);
    return 0;
  }
  char line[512];
  size_t cap = 64;
  ranges = g_malloc(cap * sizeof(Range));
  while (fgets(line, sizeof(line), file) != NULL) {
    char *p = line;
    while (*p == ' ' || *p == '\t') p++;
    if (*p == '#' || *p == '\n' || *p == '\0') continue;
    char a[128], b[128], c[128];
    int n = sscanf(p, "%127s %127s %127s", a, b, c);
    if (n == 2 && strcmp(a, "kernel") == 0) {
      kernel_base = strtoull(b, NULL, 16);
      have_kernel_base = 1;
      kernel_segment = segment_index("kernel");
      continue;
    }
    if (n != 3) {
      fprintf(stderr, "pocketcount: bad segmap line: %s", line);
      continue;
    }
    if (nranges == cap) {
      cap *= 2;
      ranges = g_realloc(ranges, cap * sizeof(Range));
    }
    ranges[nranges].start = strtoull(a, NULL, 16);
    ranges[nranges].end = strtoull(b, NULL, 16);
    ranges[nranges].segment = segment_index(c);
    nranges += 1;
  }
  fclose(file);
  qsort(ranges, nranges, sizeof(Range), range_compare);
  return 1;
}

static int segment_of(uint64_t vaddr) {
  if (have_kernel_base && vaddr >= kernel_base) return kernel_segment;
  size_t lo = 0;
  size_t hi = nranges;
  while (lo < hi) {
    size_t mid = lo + (hi - lo) / 2;
    if (ranges[mid].end <= vaddr) lo = mid + 1;
    else if (ranges[mid].start > vaddr) hi = mid;
    else return ranges[mid].segment;
  }
  return 0;
}

/* ---- per-frame storage ---------------------------------------------------- */

static FrameCounts *frame_counts_in(
  FrameCounts **storage, size_t *capacity, uint64_t *maximum, uint64_t frame) {
  if (frame >= MAX_FRAMES) return NULL;
  if (frame >= *capacity) {
    size_t new_cap = *capacity == 0 ? 256 : *capacity;
    while (new_cap <= frame) new_cap *= 2;
    *storage = g_realloc(*storage, new_cap * sizeof(FrameCounts));
    memset(*storage + *capacity, 0, (new_cap - *capacity) * sizeof(FrameCounts));
    *capacity = new_cap;
  }
  if (frame > *maximum) *maximum = frame;
  (*storage)[frame].used = 1;
  return &(*storage)[frame];
}

static FrameCounts *frame_counts(uint64_t frame) {
  return frame_counts_in(&frames, &frames_cap, &max_frame, frame);
}

static RunCounts *run_counts(uint64_t run_id) {
  if (run_id >= MAX_RUNS) return NULL;
  if (run_id >= runs_cap) {
    size_t new_cap = runs_cap == 0 ? 16 : runs_cap;
    while (new_cap <= run_id) new_cap *= 2;
    runs = g_realloc(runs, new_cap * sizeof(RunCounts));
    memset(runs + runs_cap, 0, (new_cap - runs_cap) * sizeof(RunCounts));
    runs_cap = new_cap;
  }
  runs[run_id].used = 1;
  return &runs[run_id];
}

static FrameCounts *run_frame_counts(RunCounts *run, uint64_t frame) {
  if (run == NULL) return NULL;
  return frame_counts_in(&run->frames, &run->frames_cap, &run->max_frame, frame);
}

/* ---- counting ------------------------------------------------------------- */

static qemu_plugin_u64 insn_entry(int segment) {
  qemu_plugin_u64 entry;
  entry.score = score;
  entry.offset = offsetof(Score, insns) + (size_t)segment * sizeof(uint64_t);
  return entry;
}

/* Attribute every instruction executed since the last marker to the stage
 * that was active, then snapshot. Called on each marker and at exit. */
static void flush_counts(void) {
  FrameCounts *fc = frame_counts(cur_frame);
  RunCounts *run = run_counts(cur_run);
  FrameCounts *rfc = run_frame_counts(run, cur_frame);
  for (int s = 0; s < nsegments; s++) {
    uint64_t now = qemu_plugin_u64_sum(insn_entry(s));
    uint64_t delta = now - last_insns[s];
    last_insns[s] = now;
    if (delta == 0) continue;
    acc[s][cur_stage].insns += delta;
    if (fc != NULL) fc->c[s][cur_stage].insns += delta;
    if (run != NULL) run->c[s][cur_stage].insns += delta;
    if (rfc != NULL) rfc->c[s][cur_stage].insns += delta;
  }
}

static uint64_t read_payload(int index) {
  g_byte_array_set_size(reg_buf, 0);
  int n = qemu_plugin_read_register(payload_regs[index], reg_buf);
  uint64_t value = 0;
  for (int i = 0; i < n && i < 8; i++) value |= (uint64_t)reg_buf->data[i] << (8 * i);
  return value;
}

static void marker_cb(unsigned int vcpu_index, void *udata) {
  (void)vcpu_index;
  (void)udata;
  if (payload_regs[0] == NULL || payload_regs[1] == NULL || payload_regs[2] == NULL) return;
  uint64_t magic = read_payload(2);
  if (magic != MARKER_MAGIC) {
    marker_misses += 1;
    return;
  }
  uint64_t stage = read_payload(0);
  uint64_t frame = read_payload(1);
  flush_counts();
  if (stage == RUN_MARKER_STAGE) {
    cur_run = frame;
    cur_stage = 0;
    cur_frame = 0;
    marker_hits += 1;
    return;
  }
  cur_stage = stage < NSTAGES ? (int)stage : 0;
  cur_frame = frame;
  marker_hits += 1;
}

static void mem_cb(unsigned int vcpu_index, qemu_plugin_meminfo_t info, uint64_t vaddr, void *udata) {
  (void)vcpu_index;
  int segment = (int)(intptr_t)udata;
  uint64_t bytes = 1ULL << qemu_plugin_mem_size_shift(info);
  Counts *a = &acc[segment][cur_stage];
  FrameCounts *fc = frame_counts(cur_frame);
  Counts *f = fc != NULL ? &fc->c[segment][cur_stage] : NULL;
  RunCounts *run = run_counts(cur_run);
  FrameCounts *rfc = run_frame_counts(run, cur_frame);
  Counts *ra = run != NULL ? &run->c[segment][cur_stage] : NULL;
  Counts *rf = rfc != NULL ? &rfc->c[segment][cur_stage] : NULL;
  if (qemu_plugin_mem_is_store(info)) {
    a->stores += 1;
    a->store_bytes += bytes;
    if (f != NULL) {
      f->stores += 1;
      f->store_bytes += bytes;
    }
    if (ra != NULL) {
      ra->stores += 1;
      ra->store_bytes += bytes;
    }
    if (rf != NULL) {
      rf->stores += 1;
      rf->store_bytes += bytes;
    }
  } else {
    a->loads += 1;
    a->load_bytes += bytes;
    if (f != NULL) {
      f->loads += 1;
      f->load_bytes += bytes;
    }
    if (ra != NULL) {
      ra->loads += 1;
      ra->load_bytes += bytes;
    }
    if (rf != NULL) {
      rf->loads += 1;
      rf->load_bytes += bytes;
    }
  }
  if (observe) lineset_add(&data_lines, vaddr >> 6);
}

static void tb_exec_cb(unsigned int vcpu_index, void *udata) {
  (void)vcpu_index;
  const TbLines *lines = udata;
  for (uint64_t line = lines->start_line; line <= lines->end_line; line++) lineset_add(&code_lines, line);
}

static int is_marker(const uint8_t *bytes, size_t size) {
  static const uint8_t AARCH64[4] = {0x21, 0x00, 0x01, 0xAA}; /* orr x1, x1, x1 */
  static const uint8_t A32[4] = {0x01, 0x10, 0xA0, 0xE1};     /* mov r1, r1 */
  static const uint8_t T32[2] = {0x09, 0x46};                 /* mov r1, r1 (16-bit) */
  if (arch == ARCH_AARCH64) return size == 4 && memcmp(bytes, AARCH64, 4) == 0;
  if (arch == ARCH_ARM) {
    if (size == 4 && memcmp(bytes, A32, 4) == 0) return 1;
    if (size == 2 && memcmp(bytes, T32, 2) == 0) return 1;
  }
  return 0;
}

static void vcpu_tb_trans(qemu_plugin_id_t id, struct qemu_plugin_tb *tb) {
  (void)id;
  size_t n = qemu_plugin_tb_n_insns(tb);
  uint64_t tb_start = 0;
  uint64_t tb_end = 0;
  for (size_t i = 0; i < n; i++) {
    struct qemu_plugin_insn *insn = qemu_plugin_tb_get_insn(tb, i);
    uint64_t vaddr = qemu_plugin_insn_vaddr(insn);
    size_t size = qemu_plugin_insn_size(insn);
    int segment = segment_of(vaddr);
    uint8_t bytes[8];
    size_t got = qemu_plugin_insn_data(insn, bytes, sizeof(bytes));
    if (is_marker(bytes, got)) {
      qemu_plugin_register_vcpu_insn_exec_cb(insn, marker_cb, QEMU_PLUGIN_CB_R_REGS, NULL);
    }
    qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu(
      insn, QEMU_PLUGIN_INLINE_ADD_U64, insn_entry(segment), 1);
    qemu_plugin_register_vcpu_mem_cb(
      insn, mem_cb, QEMU_PLUGIN_CB_NO_REGS, QEMU_PLUGIN_MEM_RW, (void *)(intptr_t)segment);
    if (i == 0) tb_start = vaddr;
    tb_end = vaddr + size;
  }
  if (observe && n > 0) {
    TbLines *lines = g_new(TbLines, 1);
    lines->start_line = tb_start >> 6;
    lines->end_line = (tb_end - 1) >> 6;
    qemu_plugin_register_vcpu_tb_exec_cb(tb, tb_exec_cb, QEMU_PLUGIN_CB_NO_REGS, lines);
  }
}

/* ---- registers ------------------------------------------------------------ */

static void vcpu_init(qemu_plugin_id_t id, unsigned int vcpu_index) {
  (void)id;
  if (vcpu_index != 0) return; /* -smp 1: the bench owns vCPU 0 */
  const char *const *names = arch == ARCH_AARCH64
    ? (const char *const[]){"x1", "x2", "x3"}
    : (const char *const[]){"r1", "r2", "r3"};
  GArray *regs = qemu_plugin_get_registers();
  for (guint i = 0; i < regs->len; i++) {
    qemu_plugin_reg_descriptor *desc = &g_array_index(regs, qemu_plugin_reg_descriptor, i);
    for (int k = 0; k < 3; k++) {
      if (strcmp(desc->name, names[k]) == 0) payload_regs[k] = desc->handle;
    }
  }
  g_array_free(regs, TRUE);
  if (payload_regs[0] == NULL || payload_regs[1] == NULL || payload_regs[2] == NULL) {
    fprintf(stderr, "pocketcount: payload registers not found; markers will be ignored\n");
  }
}

/* ---- output --------------------------------------------------------------- */

static void write_counts(FILE *out, const Counts *c) {
  fprintf(
    out,
    "{\"insns\":%" PRIu64 ",\"loads\":%" PRIu64 ",\"stores\":%" PRIu64 ",\"load_bytes\":%" PRIu64 ",\"store_bytes\":%" PRIu64 "}",
    c->insns, c->loads, c->stores, c->load_bytes, c->store_bytes);
}

static int counts_empty(const Counts *c) {
  return c->insns == 0 && c->loads == 0 && c->stores == 0;
}

static void write_segment_stage_table(FILE *out, Counts table[MAX_SEGMENTS][NSTAGES]) {
  fputc('{', out);
  int first_segment = 1;
  for (int s = 0; s < nsegments; s++) {
    int any = 0;
    for (int st = 0; st < NSTAGES; st++) any |= !counts_empty(&table[s][st]);
    if (!any) continue;
    fprintf(out, "%s\"%s\":{", first_segment ? "" : ",", segment_names[s]);
    first_segment = 0;
    int first_stage = 1;
    for (int st = 0; st < NSTAGES; st++) {
      if (counts_empty(&table[s][st])) continue;
      fprintf(out, "%s\"%s\":", first_stage ? "" : ",", STAGE_NAMES[st]);
      first_stage = 0;
      write_counts(out, &table[s][st]);
    }
    fputc('}', out);
  }
  fputc('}', out);
}

static void write_frames(FILE *out, FrameCounts *table, size_t capacity, uint64_t maximum) {
  int first = 1;
  fputc('[', out);
  for (uint64_t f = 0; table != NULL && f < capacity && f <= maximum; f++) {
    if (!table[f].used) continue;
    fprintf(out, "%s{\"frame\":%" PRIu64 ",\"by_segment_stage\":", first ? "" : ",", f);
    first = 0;
    write_segment_stage_table(out, table[f].c);
    fputc('}', out);
  }
  fputc(']', out);
}

static int run_has_non_idle(const RunCounts *run) {
  for (int s = 0; s < nsegments; s++) {
    for (int st = 1; st < NSTAGES; st++) {
      if (!counts_empty(&run->c[s][st])) return 1;
    }
  }
  return 0;
}

static void plugin_exit(qemu_plugin_id_t id, void *udata) {
  (void)id;
  (void)udata;
  flush_counts();
  FILE *out = out_path != NULL ? fopen(out_path, "w") : stdout;
  if (out == NULL) {
    fprintf(stderr, "pocketcount: cannot write %s\n", out_path);
    return;
  }
  Counts totals;
  memset(&totals, 0, sizeof(totals));
  for (int s = 0; s < nsegments; s++) {
    for (int st = 0; st < NSTAGES; st++) {
      totals.insns += acc[s][st].insns;
      totals.loads += acc[s][st].loads;
      totals.stores += acc[s][st].stores;
      totals.load_bytes += acc[s][st].load_bytes;
      totals.store_bytes += acc[s][st].store_bytes;
    }
  }
  fprintf(out, "{\"plugin\":\"pocketcount\",\"version\":2,\"arch\":\"%s\",\"observe\":%d,",
          arch == ARCH_AARCH64 ? "aarch64" : arch == ARCH_ARM ? "arm" : "unknown", observe);
  fprintf(out, "\"marker_hits\":%" PRIu64 ",\"marker_misses\":%" PRIu64 ",", marker_hits, marker_misses);
  fputs("\"segments\":[", out);
  for (int s = 0; s < nsegments; s++) fprintf(out, "%s\"%s\"", s ? "," : "", segment_names[s]);
  fputs("],\"stages\":[", out);
  for (int st = 0; st < NSTAGES; st++) fprintf(out, "%s\"%s\"", st ? "," : "", STAGE_NAMES[st]);
  fputs("],\"totals\":", out);
  write_counts(out, &totals);
  fputs(",\"by_segment_stage\":", out);
  write_segment_stage_table(out, acc);
  fputs(",\"by_frame\":", out);
  write_frames(out, frames, frames_cap, max_frame);
  fputs(",\"by_run\":[", out);
  int first_run = 1;
  for (uint64_t r = 0; r < runs_cap; r++) {
    if (!runs[r].used || !run_has_non_idle(&runs[r])) continue;
    fprintf(out, "%s{\"run_id\":%" PRIu64 ",\"by_segment_stage\":", first_run ? "" : ",", r);
    first_run = 0;
    write_segment_stage_table(out, runs[r].c);
    fputs(",\"by_frame\":", out);
    write_frames(out, runs[r].frames, runs[r].frames_cap, runs[r].max_frame);
    fputc('}', out);
  }
  fputs("]", out);
  if (observe) {
    fprintf(out, ",\"working_set\":{\"code_lines_64b\":%zu,\"data_lines_64b\":%zu}", code_lines.count, data_lines.count);
  }
  fputs("}\n", out);
  if (out != stdout) fclose(out);
}

/* ---- install -------------------------------------------------------------- */

QEMU_PLUGIN_EXPORT int qemu_plugin_install(
  qemu_plugin_id_t id, const qemu_info_t *info, int argc, char **argv) {
  const char *segmap = NULL;
  for (int i = 0; i < argc; i++) {
    char **kv = g_strsplit(argv[i], "=", 2);
    if (kv[0] != NULL && kv[1] != NULL) {
      if (strcmp(kv[0], "segmap") == 0) segmap = g_strdup(kv[1]);
      else if (strcmp(kv[0], "out") == 0) out_path = g_strdup(kv[1]);
      else if (strcmp(kv[0], "observe") == 0) observe = atoi(kv[1]);
      else fprintf(stderr, "pocketcount: unknown option %s\n", argv[i]);
    }
    g_strfreev(kv);
  }
  if (strcmp(info->target_name, "aarch64") == 0) arch = ARCH_AARCH64;
  else if (strcmp(info->target_name, "arm") == 0) arch = ARCH_ARM;
  else {
    fprintf(stderr, "pocketcount: unsupported target %s (arm / aarch64 only)\n", info->target_name);
    return -1;
  }
  if (info->system_emulation && info->system.smp_vcpus != 1) {
    fprintf(stderr, "pocketcount: markers assume -smp 1 (got %d vCPUs)\n", info->system.smp_vcpus);
  }
  segment_index("other");
  if (segmap != NULL && !load_segmap(segmap)) return -1;
  score = qemu_plugin_scoreboard_new(sizeof(Score));
  reg_buf = g_byte_array_new();
  if (observe) {
    lineset_init(&code_lines);
    lineset_init(&data_lines);
  }
  qemu_plugin_register_vcpu_init_cb(id, vcpu_init);
  qemu_plugin_register_vcpu_tb_trans_cb(id, vcpu_tb_trans);
  qemu_plugin_register_atexit_cb(id, plugin_exit, NULL);
  return 0;
}
