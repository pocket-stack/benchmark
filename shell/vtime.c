/*
 * shell/vtime.c — virtual time. QuickJS's Date.now() (and the Math.random
 * seed) read gettimeofday(); this definition shadows libc's for every object
 * linked into the shell, so the guest sees frame time, never the wall clock.
 * The shell itself never asks for wall time.
 */
#include "vtime.h"

#include <sys/time.h>

static uint64_t virtual_us;
static uint64_t frame_us = 1000000ULL / 60ULL;

void pb_vtime_set_hz(uint32_t hz) {
  if (hz > 0) frame_us = 1000000ULL / hz;
}

void pb_vtime_set_frame(uint32_t frame) {
  /* 2026-01-01T00:00:00Z as the epoch: a fixed, plausible Date.now(). */
  virtual_us = 1767225600ULL * 1000000ULL + (uint64_t)frame * frame_us;
}

int gettimeofday(struct timeval *tv, void *tz) {
  (void)tz;
  if (tv != 0) {
    tv->tv_sec = (time_t)(virtual_us / 1000000ULL);
    tv->tv_usec = (suseconds_t)(virtual_us % 1000000ULL);
  }
  return 0;
}
