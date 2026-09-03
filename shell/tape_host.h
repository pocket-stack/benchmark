/*
 * shell/tape_host.h — the guest-tape answering host.
 *
 * In the guest-tape build every ui_* call pocket_runtime.c makes is renamed
 * (generated/tape_ops.h) into wrappers that encode the call and hand it
 * here. The host walks the MutationTape in lockstep: each call must equal
 * the next recorded OP record word for word, queries are answered with the
 * recorded RET values, and the core is never touched. Any divergence —
 * different op, different argument, an extra or a missing call — prints the
 * position and exits 5: a passing run is a proof that the guest reproduced
 * the recording exactly.
 */
#ifndef PB_TAPE_HOST_H
#define PB_TAPE_HOST_H

#include <stddef.h>
#include <stdint.h>

/* Load and validate a MutationTape; exits on malformed input. */
int pb_tape_open(const char *path);
/* Consume the next FRAME record: 1 with the fields filled, 0 at END.
 * Exits 5 when unmatched OP records remain in the previous frame. */
int pb_tape_frame(uint32_t *frame_index, uint32_t *buttons, uint32_t *ticks);

/* FRAME-or-ACTION event stream for drivers that replay bench recordings. */
typedef struct {
  int kind; /* PB_RECORD_FRAME or PB_RECORD_ACTION */
  uint32_t frame_index;
  uint32_t buttons;
  uint32_t ticks;
  uint32_t iteration; /* PB_ACTION_* */
  char action[128];
} PbTapeEvent;
/* 1 with `event` filled, 0 at END; exits 5 on lockstep violations. */
int pb_tape_next(PbTapeEvent *event);
/* OPs matched so far (eval segment included). */
uint64_t pb_tape_matched_ops(void);

/* Used by the generated wrappers. */
void pb_tape_op_begin(uint32_t op);
void pb_tape_word(uint32_t word);
void pb_tape_f32(float value);
void pb_tape_f64(double value);
void pb_tape_bytes(const uint8_t *bytes, size_t length);
void pb_tape_op_end(void);
int32_t pb_tape_ret_i32(void);
float pb_tape_ret_f32(void);
void pb_tape_ret_skip(void);
void pb_tape_prop_batch(const uint8_t *records, size_t length);

/* No-op stubs for the lifecycle / read-only ui_* symbols pocket_runtime.c
 * links (renamed by tape_ops.h). The core stays untouched. */
void pb_tape_ui_init(uint32_t raster_density);
void pb_tape_ui_shutdown(void);
void pb_tape_ui_set_viewport(float width, float height);
void pb_tape_ui_tick(void);
const uint8_t *pb_tape_ui_render_incremental(void);
uint32_t pb_tape_ui_framebuffer_width(void);
uint32_t pb_tape_ui_framebuffer_height(void);
uint32_t pb_tape_ui_framebuffer_stride(void);
size_t pb_tape_ui_framebuffer_len(void);
uint64_t pb_tape_ui_damage_attempts(void);
uint64_t pb_tape_ui_damage_failures(void);
uint64_t pb_tape_ui_damage_full_redraws(void);
uint64_t pb_tape_ui_damage_pixels(void);
int32_t pb_tape_ui_damage_bounds(int32_t *out);
int32_t pb_tape_ui_gl_initialize(void);
void pb_tape_ui_gl_reset_resources(void);
void pb_tape_ui_gl_shutdown(void);
int32_t pb_tape_ui_gl_render(int32_t x, int32_t y, int32_t w, int32_t h, int32_t ww, int32_t wh);
void pb_tape_ui_debug_inspect(int32_t id);
int32_t pb_tape_ui_debug_rect_xy(void);
int32_t pb_tape_ui_debug_rect_wh(void);
void pb_tape_ui_debug_pause(int32_t paused);
void pb_tape_ui_debug_step(void);

#endif
