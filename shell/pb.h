/*
 * shell/pb.h — C declarations of crates/pocket-bench's ABI (see its lib.rs).
 * The ui_* ops, ui_init / ui_set_viewport / ui_tick and friends come from
 * pocket_core.h (engine/symbian's ABI, re-exported by the same staticlib).
 */
#ifndef PB_H
#define PB_H

#include <stddef.h>
#include <stdint.h>

#define PB_ABI_VERSION 1U

#define PB_ERR_ARGS (-1)
#define PB_ERR_MAGIC (-2)
#define PB_ERR_VERSION (-3)
#define PB_ERR_TRUNCATED (-4)
#define PB_ERR_RECORD (-5)
#define PB_ERR_UNKNOWN_OP (-6)
#define PB_ERR_NOT_OPEN (-7)
#define PB_ERR_STATE (-8)

typedef struct {
  uint32_t frame_index;
  uint32_t buttons;
  uint32_t analog;
  uint32_t ticks;
} PbFrame;

typedef struct {
  uint32_t version;
  uint32_t host_abi;
  uint32_t source;
  uint32_t framework;
  uint32_t viewport_w;
  uint32_t viewport_h;
  uint32_t raster_density;
  uint32_t sim_hz;
  uint32_t tick_hz;
  uint32_t frame_count;
  uint32_t record_words;
  uint32_t atlas_count;
} PbTapeInfo;

uint32_t pb_abi_version(void);

int32_t pb_draw(const uint32_t **out_ptr, size_t *out_len);
uint64_t pb_words_hash(const uint32_t *words, size_t len);
size_t pb_framebuffer_len(uint32_t scale);
int32_t pb_render_rgba8(const uint32_t *words, size_t len, uint8_t *fb, size_t fb_len, uint32_t scale);
void pb_tick(uint32_t count);
int32_t pb_set_tick_rate(uint32_t hz);
int32_t pb_load_pak(const uint8_t *pak, size_t len);

int32_t pb_replay_open(const uint8_t *tape, size_t len);
int32_t pb_replay_info(PbTapeInfo *out);
int32_t pb_replay_next(PbFrame *out);
uint32_t pb_replay_mismatches(void);
uint32_t pb_replay_ops_applied(void);
void pb_replay_close(void);

#endif
