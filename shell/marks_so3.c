/*
 * shell/marks_so3.c — SO3 build: stage boundaries as plugin markers.
 *
 * The protocol is the one plugin/smoke validated on real QEMU (10.0.11,
 * aarch64 EL1 and arm32 A32/T32): a semantic NOP the compiler never emits,
 * executed with the payload in registers —
 *
 *   AArch64:  orr x1, x1, x1   (0xAA010021)   x3 = magic, x1 = stage, x2 = frame
 *   A32:      mov r1, r1       (0xE1A01001)   r3 = magic, r1 = stage, r2 = frame
 *   T32:      mov r1, r1       (0x4609)
 * Stage PB_STAGE_COUNT is a run boundary and carries run_id instead of frame
 * in x2/r2, keeping frame zero separate across shell processes.
 *
 * magic = 0x504B4D4B ("KMKP"). The instruction costs one NOP on real
 * hardware; the plugin recognizes it at translation time, reads the
 * registers, and attributes the marker instruction itself to the stage it
 * enters. pb_marks_stage_us() has no meaning in this build — time is not
 * measured here at all; the reference machine counts instructions.
 */
#include "marks.h"

#define PB_MARKER_MAGIC 0x504B4D4BU
#define PB_MARKER_RUN_STAGE PB_STAGE_COUNT

static uint32_t current_frame;

static void emit_marker(uint32_t stage, uint32_t frame) {
#if defined(__aarch64__)
  register uint64_t stage_register __asm__("x1") = stage;
  register uint64_t frame_register __asm__("x2") = frame;
  register uint64_t magic_register __asm__("x3") = PB_MARKER_MAGIC;
  __asm__ volatile("orr x1, x1, x1" : "+r"(stage_register) : "r"(frame_register), "r"(magic_register));
#elif defined(__arm__)
  register uint32_t stage_register __asm__("r1") = stage;
  register uint32_t frame_register __asm__("r2") = frame;
  register uint32_t magic_register __asm__("r3") = PB_MARKER_MAGIC;
  __asm__ volatile("mov r1, r1" : "+r"(stage_register) : "r"(frame_register), "r"(magic_register));
#else
#error "marks_so3.c is for the SO3 arm builds; the host build uses marks_host.c"
#endif
}

void pb_marks_begin_run(uint32_t run_id) {
  /* A stage id immediately after the public stage range is a run boundary;
   * the frame register carries the run id for this marker only. */
  emit_marker(PB_MARKER_RUN_STAGE, run_id);
}

void pb_marks_begin_frame(uint32_t frame) {
  current_frame = frame;
}

void pb_marks_stage(int stage) {
  emit_marker((uint32_t)stage, current_frame);
}

uint64_t pb_marks_stage_us(int stage) {
  (void)stage;
  return 0; /* the reference machine reports instructions, not time */
}

void pocket_bench_stage(int stage) { pb_marks_stage(stage); }
