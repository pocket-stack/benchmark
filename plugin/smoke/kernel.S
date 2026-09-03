/*
 * plugin/smoke/kernel.S — minimal aarch64 bare-metal kernel that exercises the
 * pocketcount marker protocol with exactly known instruction counts.
 *
 * Frame 0:
 *   stage js (2):   marker + mov + 1000 × (nop; subs; b.ne) + mov      = 3003
 *   stage tick (4): marker + mov + 500 × (nop; nop; subs; b.ne) + 2×mov = 2004
 * Frame 1:
 *   stage js (2):   marker + mov + 100 × (nop; subs; b.ne) + mov       = 303
 *
 * The marker instruction is attributed to the stage it ENTERS (the plugin
 * registers the marker callback before the inline counter, so the flush runs
 * first and the +1 lands in the new stage); assert.py pins that rule, the
 * per-frame split, and that no load or store happens anywhere (constants via
 * movz/movk, the semihosting block address via adr).
 *
 * Exit is semihosting SYS_EXIT (0x18); run with -semihosting.
 */

  .section .text
  .global _start
_start:
  /* magic in x3, present at every marker */
  movz x3, #0x4D4B
  movk x3, #0x504B, lsl #16
  mov  x2, #7                 /* logical run 7 */
  mov  x1, #8                 /* run-boundary marker */
  .inst 0xAA010021
  mov  x2, #0                 /* frame 0 */

  mov  x1, #2                 /* stage js */
  .inst 0xAA010021            /* marker: orr x1, x1, x1 */

  mov  x4, #1000
1:
  nop
  subs x4, x4, #1
  b.ne 1b

  mov  x1, #4                 /* stage tick */
  .inst 0xAA010021

  mov  x4, #500
2:
  nop
  nop
  subs x4, x4, #1
  b.ne 2b

  mov  x2, #1                 /* frame 1 (still counted into frame 0's tick) */
  mov  x1, #2                 /* stage js */
  .inst 0xAA010021

  mov  x4, #100
3:
  nop
  subs x4, x4, #1
  b.ne 3b

  mov  x1, #0                 /* stage idle */
  .inst 0xAA010021

  /* semihosting SYS_EXIT: w0 = 0x18, x1 -> { reason, exit code } */
  adr  x1, exit_block
  mov  x0, #0x18
  hlt  #0xF000
hang:
  b hang

  .balign 16
exit_block:
  .quad 0x20026               /* ADP_Stopped_ApplicationExit */
  .quad 0
