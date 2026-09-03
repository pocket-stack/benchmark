/*
 * shell/record.c — op counters and the MutationTape writer. Layout constants
 * come from generated/pocket_tape.h (spec/tape.ts); nothing here knows an op
 * number by heart.
 */
#include "record.h"

#include "generated/pocket_tape.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PB_OP_CODES 64
#define PB_MAX_ATLASES 32

static PbOpCounter counters[PB_OP_CODES];
static uint64_t total_calls;
static uint64_t boundary_calls;
static uint64_t total_bytes;
static uint64_t text_bytes;
static uint64_t nodes_created;
static uint64_t nodes_destroyed;
static uint64_t styles_hash;
static uint64_t atlas_hashes[PB_MAX_ATLASES];
static uint32_t atlas_count;

static int armed;
static uint32_t *words;
static size_t word_count;
static size_t word_capacity;
static size_t op_header_index;
static uint32_t current_op;
static uint32_t frame_count;

uint64_t pb_fnv1a64(const uint8_t *bytes, size_t length) {
  uint64_t hash = 0xcbf29ce484222325ULL;
  size_t i;
  for (i = 0; i < length; ++i) {
    hash ^= bytes[i];
    hash *= 0x00000100000001b3ULL;
  }
  return hash;
}

/* ---- counters ----------------------------------------------------------- */

void pb_record_reset_counters(void) {
  memset(counters, 0, sizeof(counters));
  total_calls = 0;
  boundary_calls = 0;
  total_bytes = 0;
  text_bytes = 0;
  nodes_created = 0;
  nodes_destroyed = 0;
}

uint64_t pb_record_total_calls(void) { return total_calls; }
uint64_t pb_record_boundary_calls(void) { return boundary_calls; }
uint64_t pb_record_total_bytes(void) { return total_bytes; }
uint64_t pb_record_text_bytes(void) { return text_bytes; }
uint64_t pb_record_nodes_created(void) { return nodes_created; }
uint64_t pb_record_nodes_destroyed(void) { return nodes_destroyed; }

const PbOpCounter *pb_record_counter(uint32_t op) {
  return op < PB_OP_CODES ? &counters[op] : NULL;
}

/* ---- writer -------------------------------------------------------------- */

static int reserve(size_t extra) {
  size_t needed = word_count + extra;
  uint32_t *grown;
  size_t capacity;
  if (needed <= word_capacity) return 1;
  capacity = word_capacity == 0 ? 4096 : word_capacity;
  while (capacity < needed) capacity *= 2;
  grown = (uint32_t *)realloc(words, capacity * sizeof(uint32_t));
  if (grown == NULL) {
    fputs("pocket-bench-shell: tape buffer out of memory\n", stderr);
    armed = 0;
    return 0;
  }
  words = grown;
  word_capacity = capacity;
  return 1;
}

static void put(uint32_t word) {
  if (!armed) return;
  if (!reserve(1)) return;
  words[word_count++] = word;
}

static uint32_t record_header(uint32_t kind, uint32_t payload_words) {
  return (kind & PB_RECORD_KIND_MASK) | (payload_words << PB_RECORD_PAYLOAD_SHIFT);
}

int pb_record_arm(void) {
  if (armed) return -1;
  armed = 1;
  word_count = 0;
  frame_count = 0;
  return 0;
}

void pb_record_discard(void) {
  free(words);
  words = NULL;
  word_count = 0;
  word_capacity = 0;
  armed = 0;
}

void pb_record_frame(uint32_t frame_index, uint32_t buttons, uint32_t analog, uint32_t ticks) {
  if (!armed) return;
  put(record_header(PB_RECORD_FRAME, PB_FRAME_FIXED_WORDS));
  put(frame_index);
  put(buttons);
  put(analog);
  put(ticks);
  put(0); /* touch words: the shell drives no touch contacts */
  frame_count += 1;
}

static void op_begin(uint32_t op) {
  current_op = op;
  total_calls += 1;
  if (op < PB_OP_CODES) counters[op].calls += 1;
  if (op == 1U) nodes_created += 1;  /* createNode */
  if (op == 2U) nodes_destroyed += 1; /* destroyNode */
  if (!armed) return;
  op_header_index = word_count;
  put(record_header(PB_RECORD_OP, 0));
  put(op);
}

void pb_record_action(const char *name, uint32_t iteration) {
  size_t length = strlen(name);
  size_t header_index;
  size_t i;
  if (!armed) return;
  header_index = word_count;
  put(record_header(PB_RECORD_ACTION, 0));
  put(iteration);
  put((uint32_t)length);
  for (i = 0; i < length; i += 4) {
    uint32_t word = 0;
    size_t take = length - i < 4 ? length - i : 4;
    memcpy(&word, name + i, take);
    put(word);
  }
  if (armed) words[header_index] = record_header(PB_RECORD_ACTION, (uint32_t)(word_count - header_index - 1));
}

void pb_record_op_begin(uint32_t op) {
  boundary_calls += 1;
  op_begin(op);
}

/*
 * setPropBatch: one boundary call, N setProp mutations. The records are
 * little-endian Float64 triples [nodeId, propId, value]; each becomes a
 * setProp OP record so a tape never carries a non-spec op.
 */
void ui_set_prop_batch(const uint8_t *records, size_t length);
void pb_rec_ui_set_prop_batch(const uint8_t *records, size_t length) {
  size_t i;
  boundary_calls += 1;
  for (i = 0; i + 24 <= length; i += 24) {
    double node;
    double prop;
    double value;
    memcpy(&node, records + i, 8);
    memcpy(&prop, records + i + 8, 8);
    memcpy(&value, records + i + 16, 8);
    op_begin(6U); /* setProp */
    put((uint32_t)(int32_t)node);
    put((uint32_t)prop);
    pb_record_f64(value);
    pb_record_op_end();
  }
  ui_set_prop_batch(records, length);
}

void pb_record_word(uint32_t word) { put(word); }

void pb_record_f32(float value) {
  uint32_t bits;
  memcpy(&bits, &value, sizeof(bits));
  put(bits);
}

void pb_record_f64(double value) {
  uint64_t bits;
  memcpy(&bits, &value, sizeof(bits));
  put((uint32_t)(bits & 0xffffffffULL));
  put((uint32_t)(bits >> 32));
}

void pb_record_bytes(const uint8_t *bytes, size_t length, int is_text) {
  size_t i;
  total_bytes += length;
  if (current_op < PB_OP_CODES) counters[current_op].bytes += length;
  if (is_text) text_bytes += length;
  if (current_op == 14U) styles_hash = pb_fnv1a64(bytes, length); /* loadStyles */
  if (current_op == 15U && atlas_count < PB_MAX_ATLASES) { /* loadFontAtlas */
    atlas_hashes[atlas_count++] = pb_fnv1a64(bytes, length);
  }
  if (!armed) return;
  put((uint32_t)length);
  for (i = 0; i < length; i += 4) {
    uint32_t word = 0;
    size_t take = length - i < 4 ? length - i : 4;
    memcpy(&word, bytes + i, take); /* little-endian hosts only */
    put(word);
  }
}

void pb_record_op_end(void) {
  uint32_t payload;
  if (!armed) return;
  payload = (uint32_t)(word_count - op_header_index - 1);
  words[op_header_index] = record_header(PB_RECORD_OP, payload);
}

void pb_record_ret_i32(int32_t value) {
  if (!armed) return;
  put(record_header(PB_RECORD_RET, 2));
  put(PB_RET_I32);
  put((uint32_t)value);
}

void pb_record_ret_f32(float value) {
  if (!armed) return;
  put(record_header(PB_RECORD_RET, 2));
  put(PB_RET_F32);
  pb_record_f32(value);
}

static void put_u64(uint32_t *header, size_t at, uint64_t value) {
  header[at] = (uint32_t)(value & 0xffffffffULL);
  header[at + 1] = (uint32_t)(value >> 32);
}

int pb_record_finish(const char *path, const PbTapeIdentity *identity) {
  uint32_t caps_lo = 0;
  uint32_t caps_hi = 0;
  size_t header_words = PB_MT_FIXED_WORDS + 2 * atlas_count;
  uint32_t *header;
  FILE *file;
  size_t i;
  if (!armed) {
    errno = EINVAL;
    return -1;
  }
  put(record_header(PB_RECORD_END, 0));
  for (i = 0; i < PB_BOUND_OP_COUNT; ++i) {
    uint32_t op = PB_BOUND_OPS[i];
    if (op < 32) caps_lo |= 1U << op;
    else if (op < 64) caps_hi |= 1U << (op - 32);
  }
  header = (uint32_t *)calloc(header_words, sizeof(uint32_t));
  if (header == NULL) return -1;
  header[PB_MT_MAGIC] = PB_MUTATION_TAPE_MAGIC;
  header[PB_MT_VERSION] = PB_TAPE_VERSION;
  header[PB_MT_HEADER_WORDS] = (uint32_t)header_words;
  header[PB_MT_HOST_ABI] = identity->host_abi;
  header[PB_MT_SOURCE] = identity->source;
  header[PB_MT_FRAMEWORK] = identity->framework;
  put_u64(header, PB_MT_ADAPTER_HASH, identity->adapter_hash);
  header[PB_MT_VIEWPORT_W] = identity->viewport_w;
  header[PB_MT_VIEWPORT_H] = identity->viewport_h;
  header[PB_MT_RASTER_DENSITY] = identity->raster_density;
  header[PB_MT_SIM_HZ] = identity->sim_hz;
  header[PB_MT_TICK_HZ] = identity->tick_hz;
  put_u64(header, PB_MT_BUNDLE_HASH, identity->bundle_hash);
  put_u64(header, PB_MT_PAK_HASH, identity->pak_hash);
  put_u64(header, PB_MT_STYLES_HASH, styles_hash);
  header[PB_MT_OP_CAPS_LO] = caps_lo;
  header[PB_MT_OP_CAPS_HI] = caps_hi;
  header[PB_MT_FRAME_COUNT] = frame_count;
  header[PB_MT_RECORD_WORDS] = (uint32_t)word_count;
  header[PB_MT_ATLAS_COUNT] = atlas_count;
  for (i = 0; i < atlas_count; ++i) put_u64(header, PB_MT_ATLAS_HASHES_OFFSET + 2 * i, atlas_hashes[i]);

  file = fopen(path, "wb");
  if (file == NULL) {
    free(header);
    return -1;
  }
  if (fwrite(header, sizeof(uint32_t), header_words, file) != header_words ||
      fwrite(words, sizeof(uint32_t), word_count, file) != word_count) {
    fclose(file);
    free(header);
    errno = EIO;
    return -1;
  }
  fclose(file);
  free(header);
  pb_record_discard();
  return 0;
}
