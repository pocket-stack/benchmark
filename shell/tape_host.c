/*
 * shell/tape_host.c — lockstep MutationTape matching (see tape_host.h).
 * Layout constants come from generated/pocket_tape.h; nothing here knows an
 * op number or a header offset by heart.
 */
#include "tape_host.h"

#include "generated/pocket_tape.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t *words;
static size_t word_count;
static size_t pos;      /* next unread record header */
static size_t end;      /* one past the record stream */
static uint64_t matched_ops;

/* The op currently being matched. */
static uint32_t current_op;
static size_t compare_at;   /* next payload word to compare */
static size_t payload_end;  /* one past the OP record's payload */

static void die(const char *what) {
  fprintf(
    stderr,
    "pocket-bench-shell: guest-tape lockstep failed at word %zu (op %u, %llu matched): %s\n",
    pos,
    current_op,
    (unsigned long long)matched_ops,
    what
  );
  exit(5);
}

int pb_tape_open(const char *path) {
  FILE *file = fopen(path, "rb");
  long size;
  size_t header_words;
  if (file == NULL) {
    fprintf(stderr, "pocket-bench-shell: cannot read %s\n", path);
    exit(4);
  }
  if (fseek(file, 0, SEEK_END) != 0 || (size = ftell(file)) < 0 || fseek(file, 0, SEEK_SET) != 0 ||
      size % 4 != 0 || (size_t)size / 4 < PB_MT_FIXED_WORDS) {
    fprintf(stderr, "pocket-bench-shell: %s is not a MutationTape\n", path);
    exit(5);
  }
  word_count = (size_t)size / 4;
  words = (uint32_t *)malloc((size_t)size);
  if (words == NULL || fread(words, 4, word_count, file) != word_count) {
    fprintf(stderr, "pocket-bench-shell: short read from %s\n", path);
    exit(4);
  }
  fclose(file);
  if (words[PB_MT_MAGIC] != PB_MUTATION_TAPE_MAGIC) die("magic mismatch");
  if (words[PB_MT_VERSION] != PB_TAPE_VERSION) die("version mismatch");
  header_words = words[PB_MT_HEADER_WORDS];
  if (header_words < PB_MT_FIXED_WORDS || header_words > word_count) die("header truncated");
  end = header_words + words[PB_MT_RECORD_WORDS];
  if (end > word_count) die("record stream truncated");
  pos = header_words;
  return 1;
}

uint64_t pb_tape_matched_ops(void) { return matched_ops; }

static uint32_t peek_kind(void) {
  if (pos >= end) die("record stream ended early");
  return words[pos] & PB_RECORD_KIND_MASK;
}

int pb_tape_frame(uint32_t *frame_index, uint32_t *buttons, uint32_t *ticks) {
  uint32_t kind = peek_kind();
  uint32_t payload;
  if (kind == PB_RECORD_ACTION) die("bench-protocol recording: drive it through pb_tape_next");
  if (kind == PB_RECORD_OP) die("the recording has ops this replay's guest never made");
  if (kind == PB_RECORD_END) return 0;
  if (kind != PB_RECORD_FRAME) die("expected a FRAME record");
  payload = words[pos] >> PB_RECORD_PAYLOAD_SHIFT;
  if (payload < PB_FRAME_FIXED_WORDS || pos + 1 + payload > end) die("FRAME record truncated");
  if (frame_index != NULL) *frame_index = words[pos + 1 + PB_FRAME_INDEX];
  if (buttons != NULL) *buttons = words[pos + 1 + PB_FRAME_BUTTONS];
  if (ticks != NULL) *ticks = words[pos + 1 + PB_FRAME_TICKS];
  pos += 1 + payload;
  return 1;
}

int pb_tape_next(PbTapeEvent *event) {
  uint32_t kind = peek_kind();
  if (kind == PB_RECORD_ACTION) {
    uint32_t payload = words[pos] >> PB_RECORD_PAYLOAD_SHIFT;
    uint32_t length;
    uint32_t i;
    if (payload < 2 || pos + 1 + payload > end) die("ACTION record truncated");
    event->kind = PB_RECORD_ACTION;
    event->iteration = words[pos + 1];
    length = words[pos + 2];
    if (length >= sizeof(event->action) || 2 + (length + 3) / 4 > payload) die("ACTION name truncated");
    for (i = 0; i < length; i += 4) {
      uint32_t word = words[pos + 3 + i / 4];
      uint32_t take = length - i < 4 ? length - i : 4;
      memcpy(event->action + i, &word, take);
    }
    event->action[length] = '\0';
    pos += 1 + payload;
    return 1;
  }
  event->kind = PB_RECORD_FRAME;
  event->action[0] = '\0';
  event->iteration = 0;
  return pb_tape_frame(&event->frame_index, &event->buttons, &event->ticks);
}

void pb_tape_op_begin(uint32_t op) {
  uint32_t kind = peek_kind();
  uint32_t payload;
  if (kind == PB_RECORD_FRAME || kind == PB_RECORD_END || kind == PB_RECORD_ACTION) {
    current_op = op;
    die("the guest made an op the recording does not have here");
  }
  if (kind != PB_RECORD_OP) die("expected an OP record");
  payload = words[pos] >> PB_RECORD_PAYLOAD_SHIFT;
  if (payload < 1 || pos + 1 + payload > end) die("OP record truncated");
  current_op = op;
  if (words[pos + 1] != op) die("op code differs from the recording");
  compare_at = pos + 2;
  payload_end = pos + 1 + payload;
  pos = payload_end;
}

static void compare_word(uint32_t word) {
  if (compare_at >= payload_end) die("the guest passed more argument words than the recording");
  if (words[compare_at] != word) die("an argument differs from the recording");
  compare_at += 1;
}

void pb_tape_word(uint32_t word) { compare_word(word); }

void pb_tape_f32(float value) {
  uint32_t bits;
  memcpy(&bits, &value, sizeof(bits));
  compare_word(bits);
}

void pb_tape_f64(double value) {
  uint64_t bits;
  memcpy(&bits, &value, sizeof(bits));
  compare_word((uint32_t)(bits & 0xffffffffULL));
  compare_word((uint32_t)(bits >> 32));
}

void pb_tape_bytes(const uint8_t *bytes, size_t length) {
  size_t i;
  compare_word((uint32_t)length);
  for (i = 0; i < length; i += 4) {
    uint32_t word = 0;
    size_t take = length - i < 4 ? length - i : 4;
    memcpy(&word, bytes + i, take);
    compare_word(word);
  }
}

void pb_tape_op_end(void) {
  if (compare_at != payload_end) die("the guest passed fewer argument words than the recording");
  matched_ops += 1;
}

static uint32_t take_ret(uint32_t expect_kind) {
  uint32_t payload;
  uint32_t value;
  if (peek_kind() != PB_RECORD_RET) die("the recording has no RET for this op");
  payload = words[pos] >> PB_RECORD_PAYLOAD_SHIFT;
  if (payload < 2 || pos + 1 + payload > end) die("RET record truncated");
  if (words[pos + 1] != expect_kind) die("RET kind differs from the recording");
  value = words[pos + 2];
  pos += 1 + payload;
  return value;
}

int32_t pb_tape_ret_i32(void) { return (int32_t)take_ret(PB_RET_I32); }

float pb_tape_ret_f32(void) {
  uint32_t bits = take_ret(PB_RET_F32);
  float value;
  memcpy(&value, &bits, sizeof(value));
  return value;
}

void pb_tape_ret_skip(void) {
  if (peek_kind() == PB_RECORD_RET) {
    uint32_t payload = words[pos] >> PB_RECORD_PAYLOAD_SHIFT;
    if (pos + 1 + payload > end) die("RET record truncated");
    pos += 1 + payload;
  }
}

void pb_tape_prop_batch(const uint8_t *records, size_t length) {
  size_t i;
  for (i = 0; i + 24 <= length; i += 24) {
    double node;
    double prop;
    double value;
    memcpy(&node, records + i, 8);
    memcpy(&prop, records + i + 8, 8);
    memcpy(&value, records + i + 16, 8);
    pb_tape_op_begin(6U); /* setProp */
    pb_tape_word((uint32_t)(int32_t)node);
    pb_tape_word((uint32_t)prop);
    pb_tape_f64(value);
    pb_tape_op_end();
  }
}

/* ---- inert lifecycle stubs: the core does not exist in this build --------- */

void pb_tape_ui_init(uint32_t raster_density) { (void)raster_density; }
void pb_tape_ui_shutdown(void) {}
void pb_tape_ui_set_viewport(float width, float height) {
  (void)width;
  (void)height;
}
void pb_tape_ui_tick(void) {}
const uint8_t *pb_tape_ui_render_incremental(void) { return NULL; }
uint32_t pb_tape_ui_framebuffer_width(void) { return 0; }
uint32_t pb_tape_ui_framebuffer_height(void) { return 0; }
uint32_t pb_tape_ui_framebuffer_stride(void) { return 0; }
size_t pb_tape_ui_framebuffer_len(void) { return 0; }
uint64_t pb_tape_ui_damage_attempts(void) { return 0; }
uint64_t pb_tape_ui_damage_failures(void) { return 0; }
uint64_t pb_tape_ui_damage_full_redraws(void) { return 0; }
uint64_t pb_tape_ui_damage_pixels(void) { return 0; }
int32_t pb_tape_ui_damage_bounds(int32_t *out) {
  (void)out;
  return 0;
}
int32_t pb_tape_ui_gl_initialize(void) { return 0; }
void pb_tape_ui_gl_reset_resources(void) {}
void pb_tape_ui_gl_shutdown(void) {}
int32_t pb_tape_ui_gl_render(int32_t x, int32_t y, int32_t w, int32_t h, int32_t ww, int32_t wh) {
  (void)x;
  (void)y;
  (void)w;
  (void)h;
  (void)ww;
  (void)wh;
  return 0;
}
void pb_tape_ui_debug_inspect(int32_t id) { (void)id; }
int32_t pb_tape_ui_debug_rect_xy(void) { return -1; }
int32_t pb_tape_ui_debug_rect_wh(void) { return -1; }
void pb_tape_ui_debug_pause(int32_t paused) { (void)paused; }
void pb_tape_ui_debug_step(void) {}
