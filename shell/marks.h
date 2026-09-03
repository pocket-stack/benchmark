/*
 * shell/marks.h — stage boundaries. pocket_runtime.c (compiled with
 * POCKET_RUNTIME_BENCH_HOOKS) and main.c call pb_marks_stage() at every
 * phase edge; the host build attributes thread CPU time to the stage that
 * just ended, the SO3 build emits the plugin's marker instruction.
 */
#ifndef PB_MARKS_H
#define PB_MARKS_H

#include <stdint.h>

#include "generated/pocket_tape.h"

/* Announce one logical workload run. SO3 emits a marker; host timing ignores it. */
void pb_marks_begin_run(uint32_t run_id);
/* Reset per-frame accumulators and announce the frame index. */
void pb_marks_begin_frame(uint32_t frame);
/* Enter `stage` (PB_STAGE_*); the previous stage ends now. */
void pb_marks_stage(int stage);
/* Microseconds accumulated in `stage` since pb_marks_begin_frame. */
uint64_t pb_marks_stage_us(int stage);
/* pocket_runtime.c's hook name. */
void pocket_bench_stage(int stage);

#endif
