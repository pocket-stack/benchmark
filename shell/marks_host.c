/*
 * shell/marks_host.c — host build: thread CPU time per stage.
 * macOS: thread_info(THREAD_BASIC_INFO) user + system; elsewhere:
 * clock_gettime(CLOCK_THREAD_CPUTIME_ID). No wall clock anywhere.
 */
#include "marks.h"

#if defined(__APPLE__)
#include <mach/mach.h>
#include <mach/thread_act.h>
#else
#include <time.h>
#endif

static uint64_t stage_us[PB_STAGE_COUNT];
static int current_stage = PB_STAGE_IDLE;
static uint64_t stage_start_us;
static uint32_t current_frame;

static uint64_t thread_cpu_us(void) {
#if defined(__APPLE__)
  thread_basic_info_data_t info;
  mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
  thread_act_t thread = mach_thread_self();
  kern_return_t status = thread_info(thread, THREAD_BASIC_INFO, (thread_info_t)&info, &count);
  mach_port_deallocate(mach_task_self(), thread);
  if (status != KERN_SUCCESS) return 0;
  return (uint64_t)info.user_time.seconds * 1000000ULL + (uint64_t)info.user_time.microseconds +
         (uint64_t)info.system_time.seconds * 1000000ULL + (uint64_t)info.system_time.microseconds;
#else
  struct timespec ts;
  if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts) != 0) return 0;
  return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)ts.tv_nsec / 1000ULL;
#endif
}

void pb_marks_begin_run(uint32_t run_id) {
  (void)run_id;
}

void pb_marks_begin_frame(uint32_t frame) {
  int i;
  for (i = 0; i < PB_STAGE_COUNT; ++i) stage_us[i] = 0;
  current_frame = frame;
  current_stage = PB_STAGE_IDLE;
  stage_start_us = thread_cpu_us();
}

void pb_marks_stage(int stage) {
  uint64_t now = thread_cpu_us();
  if (current_stage >= 0 && current_stage < PB_STAGE_COUNT && now >= stage_start_us) {
    stage_us[current_stage] += now - stage_start_us;
  }
  current_stage = stage;
  stage_start_us = now;
}

uint64_t pb_marks_stage_us(int stage) {
  return stage >= 0 && stage < PB_STAGE_COUNT ? stage_us[stage] : 0;
}

void pocket_bench_stage(int stage) { pb_marks_stage(stage); }
