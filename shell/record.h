/*
 * shell/record.h — op counters and the MutationTape writer behind the
 * generated pb_rec_ui_* wrappers (generated/record_ops.c). Compiled only into
 * the observe build; the measure build has no wrappers at all.
 */
#ifndef PB_RECORD_H
#define PB_RECORD_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint64_t calls;
  uint64_t bytes; /* str / blob payload bytes crossing the boundary */
} PbOpCounter;

/* ---- counters (always on) ---------------------------------------------- */
void pb_record_reset_counters(void);
/* Mutations (one per op record; a setPropBatch of N triples counts N). */
uint64_t pb_record_total_calls(void);
/* JS → native calls (a setPropBatch counts 1). */
uint64_t pb_record_boundary_calls(void);
uint64_t pb_record_total_bytes(void);
uint64_t pb_record_text_bytes(void);
uint64_t pb_record_nodes_created(void);
uint64_t pb_record_nodes_destroyed(void);
/* Per-op counter by spec op code (0..63); NULL outside the range. */
const PbOpCounter *pb_record_counter(uint32_t op);

/* ---- tape writer (only when armed) -------------------------------------- */
typedef struct {
  uint32_t host_abi;
  uint32_t source;
  uint32_t framework;
  uint64_t adapter_hash;
  uint32_t viewport_w;
  uint32_t viewport_h;
  uint32_t raster_density;
  uint32_t sim_hz;
  uint32_t tick_hz;
  uint64_t bundle_hash;
  uint64_t pak_hash;
} PbTapeIdentity;

/* Start buffering records; returns 0, or -1 when already armed. */
int pb_record_arm(void);
/* One FRAME record: call before the guest turn of every frame. */
void pb_record_frame(uint32_t frame_index, uint32_t buttons, uint32_t analog, uint32_t ticks);
/* One ACTION record (bench protocol): call right before evaluating run(). */
void pb_record_action(const char *name, uint32_t iteration);
/* Write header + records + END to `path`; returns 0, or -1 with errno set. */
int pb_record_finish(const char *path, const PbTapeIdentity *identity);
void pb_record_discard(void);

/* Used by the generated wrappers. */
void pb_record_op_begin(uint32_t op);
void pb_record_word(uint32_t word);
void pb_record_f32(float value);
void pb_record_f64(double value);
void pb_record_bytes(const uint8_t *bytes, size_t length, int is_text);
void pb_record_op_end(void);
void pb_record_ret_i32(int32_t value);
void pb_record_ret_f32(float value);
/* The hand-written wrapper for the HostOps fast path (see record_ops.h). */
void pb_rec_ui_set_prop_batch(const uint8_t *records, size_t length);

uint64_t pb_fnv1a64(const uint8_t *bytes, size_t length);

#endif
