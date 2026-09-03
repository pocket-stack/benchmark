/*
 * shell/runtime_overrides.h — fed to pocket_runtime.c with `-include` in both
 * builds. It renames the two QuickJS entry points the shell must own:
 * runtime creation (so the guest heap lives in the shell's accounted arena)
 * and the job drain (so jobs are counted). Nothing in pocket_runtime.c
 * changes; the renamed symbols are implemented in jsglue.c.
 */
#ifndef PB_RUNTIME_OVERRIDES_H
#define PB_RUNTIME_OVERRIDES_H

#define JS_NewRuntime pb_js_new_runtime
#define JS_ExecutePendingJob pb_js_execute_pending_job

#endif
