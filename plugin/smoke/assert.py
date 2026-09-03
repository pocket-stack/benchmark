#!/usr/bin/env python3
# plugin/smoke/assert.py — pin the pocketcount smoke expectations.
#
#   assert.py --arch aarch64 out1.json out2.json out3.json   (kernel.S)
#   assert.py --arch arm     out1.json out2.json out3.json   (kernel_arm.S)
#
# Common rules both kernels pin:
#   - the marker instruction is attributed to the (stage, frame) it ENTERS
#     (the plugin registers the marker callback before the inline counter,
#     so the flush runs before the +1);
#   - no load/store instruction exists in the kernels, so every asserted
#     shell stage has loads == stores == 0;
#   - two plain runs are byte-identical, the -icount run counts the same.
#
# aarch64 (kernel.S):
#   frame 0 js   = marker + mov + 1000*(nop+subs+b.ne) + mov              = 3003
#   frame 0 tick = marker + mov + 500*(nop+nop+subs+b.ne) + mov + mov     = 2004
#   frame 1 js   = marker + mov + 100*(nop+subs+b.ne) + mov               = 303
# arm (kernel_arm.S; frame 0 in A32, frame 1 behind the T32 marker):
#   frame 0 js   = A32 marker + movw + 1000*(nop+subs+bne) + mov          = 3003
#   frame 0 tick = A32 marker + movw + 500*(nop+nop+subs+bne) + mov + blx
#                  + Thumb movs                                            = 2005
#   frame 1 js   = T32 marker + movs + 100*(nop+subs+bne) + movs          = 303
import json
import sys

EXPECTATIONS = {
    "aarch64": {(0, "js"): 3003, (0, "tick"): 2004, (1, "js"): 303},
    "arm": {(0, "js"): 3003, (0, "tick"): 2005, (1, "js"): 303},
}
MARKERS = 5
RUN_ID = 7


def load(path):
    with open(path) as f:
        return json.load(f)


def check(cond, message):
    if not cond:
        print(f"assert.py: FAIL: {message}", file=sys.stderr)
        sys.exit(1)


def shell_stage(table, stage):
    return table.get("shell", {}).get(stage, {"insns": 0, "loads": 0, "stores": 0})


def frame_table(doc, frame):
    for entry in doc["by_frame"]:
        if entry["frame"] == frame:
            return entry["by_segment_stage"]
    return {}


def run_table(doc, run_id):
    for entry in doc.get("by_run", []):
        if entry["run_id"] == run_id:
            return entry
    return None


args = sys.argv[1:]
check(len(args) == 5 and args[0] == "--arch" and args[1] in EXPECTATIONS, f"usage: assert.py --arch aarch64|arm out1 out2 out3 (got {args})")
arch = args[1]
expect = EXPECTATIONS[arch]
paths = args[2:]
docs = [load(p) for p in paths]

first = docs[0]
check(first["arch"] == arch, f"arch {first['arch']} != {arch}")
check(first["marker_hits"] == MARKERS, f"marker_hits {first['marker_hits']} != {MARKERS}")
check(first["marker_misses"] == 0, f"marker_misses {first['marker_misses']} != 0")
for (frame, stage), value in expect.items():
    got = shell_stage(frame_table(first, frame), stage)
    check(got["insns"] == value, f"frame {frame} shell/{stage} insns {got['insns']} != {value}")
    check(got["loads"] == 0 and got["stores"] == 0, f"frame {frame} shell/{stage} touched memory: {got}")
aggregate_js = shell_stage(first["by_segment_stage"], "js")["insns"]
check(aggregate_js == expect[(0, "js")] + expect[(1, "js")], f"aggregate shell/js {aggregate_js}")
run = run_table(first, RUN_ID)
check(run is not None, f"run {RUN_ID} missing from by_run")
for (frame, stage), value in expect.items():
    got = shell_stage(frame_table({"by_frame": run["by_frame"]}, frame), stage)
    check(got["insns"] == value, f"run {RUN_ID} frame {frame} shell/{stage} insns {got['insns']} != {value}")

with open(paths[0], "rb") as a, open(paths[1], "rb") as b:
    check(a.read() == b.read(), "run 1 and run 2 outputs differ")

icount = docs[2]
for (frame, stage), value in expect.items():
    got = shell_stage(frame_table(icount, frame), stage)["insns"]
    check(got == value, f"icount frame {frame} shell/{stage} insns {got} != {value}")
check(run_table(icount, RUN_ID) is not None, f"icount run {RUN_ID} missing from by_run")

print(
    "assert.py: ok [%s] — f0 js=%d f0 tick=%d f1 js=%d markers=%d, runs 1&2 byte-identical, icount matches"
    % (arch, expect[(0, "js")], expect[(0, "tick")], expect[(1, "js")], MARKERS)
)
