/*
 * plugin/smoke/kernel_arm.S — arm32 twin of kernel.S: exercises BOTH marker
 * encodings with exactly known instruction counts.
 *
 * Frame 0 (A32):
 *   stage js (2):   A32 marker + movw + 1000 × (nop; subs; bne)  + mov            = 3003
 *   stage tick (4): A32 marker + movw + 500 × (nop; nop; subs; bne) + mov + blx
 *                   + (Thumb) movs                                                 = 2005
 * Frame 1 (T32):
 *   stage js (2):   T32 marker + movs + 100 × (nop; subs; bne) + movs             = 303
 *
 * All constants via movw/movt (A32) and imm8 movs (Thumb): no load or store
 * anywhere, so shell loads/stores must be 0. The marker is attributed to the
 * (stage, frame) it enters — same rule the aarch64 smoke pinned.
 *
 * Exit: ARM 32-bit semihosting SYS_EXIT (0x18) with the reason in r1,
 * via A32 `svc #0x123456`; run with -semihosting.
 */

  .syntax unified
  .section .text
  .global _start

  .arm
_start:
  movw r3, #0x4D4B            /* magic */
  movt r3, #0x504B
  mov  r2, #7                 /* logical run 7 */
  mov  r1, #8                 /* run-boundary marker */
  .inst 0xE1A01001
  mov  r2, #0                 /* frame 0 */

  mov  r1, #2                 /* stage js */
  .inst 0xE1A01001            /* A32 marker: mov r1, r1 */

  movw r4, #1000
1:
  nop
  subs r4, r4, #1
  bne  1b

  mov  r1, #4                 /* stage tick */
  .inst 0xE1A01001

  movw r4, #500
2:
  nop
  nop
  subs r4, r4, #1
  bne  2b

  mov  r2, #1                 /* frame 1 (still counted into frame 0's tick) */
  blx  thumb_part             /* switches to Thumb */

  /* back in A32, stage idle (frame 1): semihosting SYS_EXIT */
  movw r1, #0x0026            /* ADP_Stopped_ApplicationExit = 0x20026 */
  movt r1, #0x0002
  mov  r0, #0x18
  svc  #0x123456
hang:
  b hang

  .thumb
  .thumb_func
thumb_part:
  movs r1, #2                 /* stage js (counted into frame 0's tick) */
  .inst.n 0x4609              /* T32 marker: mov r1, r1 (16-bit) */

  movs r4, #100
3:
  nop
  subs r4, r4, #1
  bne  3b

  movs r1, #0                 /* stage idle */
  .inst.n 0x4609
  bx   lr
