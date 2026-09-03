#!/usr/bin/env python3
"""ref/counts-summary.py — read pocketcount output JSON, print / compare.

  python3 ref/counts-summary.py counts.json               segment × stage insns table
  python3 ref/counts-summary.py counts.json --frames      aggregate per-frame table
  python3 ref/counts-summary.py counts.json --runs        one table per logical run
  python3 ref/counts-summary.py a.json --compare b.json   determinism check

The compare mode ignores the `idle` stage and `totals`: idle is everything
that is not the bench (boot, between processes, the OS shell after the last
run), and its size is set by when the host kills QEMU, not by the guest.
Everything else must match to the byte for two runs of the same image.
"""
import json, sys


def insns(cell):
    return cell.get("insns", 0) if isinstance(cell, dict) else cell


def non_idle(doc):
    """by_segment_stage and by_frame with every idle bucket dropped."""
    seg_stage = {
        seg: {st: cell for st, cell in stages.items() if st != "idle"}
        for seg, stages in doc["by_segment_stage"].items()
    }
    frames = [
        {
            "frame": fr["frame"],
            "by_segment_stage": {
                seg: {st: cell for st, cell in stages.items() if st != "idle"}
                for seg, stages in fr["by_segment_stage"].items()
            },
        }
        for fr in doc.get("by_frame", [])
    ]
    runs = [
        {
            "run_id": run["run_id"],
            "seg_stage": {
                seg: {st: cell for st, cell in stages.items() if st != "idle"}
                for seg, stages in run["by_segment_stage"].items()
            },
            "frames": [
                {
                    "frame": fr["frame"],
                    "by_segment_stage": {
                        seg: {st: cell for st, cell in stages.items() if st != "idle"}
                        for seg, stages in fr["by_segment_stage"].items()
                    },
                }
                for fr in run.get("by_frame", [])
            ],
        }
        for run in doc.get("by_run", [])
    ]
    return {"marker_misses": doc["marker_misses"], "seg_stage": seg_stage, "frames": frames, "runs": runs}


def table(doc, footer=True):
    stages = doc["stages"]
    print(f"{'segment':>8} |" + "".join(f"{s:>12}" for s in stages))
    print("-" * (10 + 12 * len(stages)))
    totals = [0] * len(stages)
    for seg in doc["segments"]:
        row = doc["by_segment_stage"].get(seg, {})
        vals = [insns(row.get(st, 0)) for st in stages]
        for i, v in enumerate(vals):
            totals[i] += v
        if sum(vals) == 0:
            continue
        print(f"{seg:>8} |" + "".join(f"{v:>12,}" for v in vals))
    print(f"{'sum':>8} |" + "".join(f"{v:>12,}" for v in totals))
    if footer:
        print(f"\nmarker_hits {doc['marker_hits']}  marker_misses {doc['marker_misses']}  "
              f"totals.insns {doc['totals']['insns']:,} (idle + U-Boot included)")


def frames_table(doc):
    print(f"{'frame':>5} |" + "".join(f"{s:>10}" for s in ("js", "tick", "draw", "render", "verify")))
    for fr in doc.get("by_frame", []):
        cells = []
        for st in ("js", "tick", "draw", "render", "verify"):
            total = sum(insns(stages.get(st, 0)) for stages in fr["by_segment_stage"].values())
            cells.append(total)
        if sum(cells) == 0:
            continue
        print(f"{fr['frame']:>5} |" + "".join(f"{v:>10,}" for v in cells))


def runs_table(doc):
    runs = doc.get("by_run", [])
    if not runs:
        print("no by_run data (pocketcount v2 is required)")
        return
    for index, run in enumerate(runs):
        if index:
            print()
        print(f"run {run['run_id']}")
        scoped = dict(doc)
        scoped["by_segment_stage"] = run["by_segment_stage"]
        scoped["by_frame"] = run.get("by_frame", [])
        table(scoped, footer=False)


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    doc = json.load(open(args[0]))
    if "--compare" in args:
        other = json.load(open(args[args.index("--compare") + 1]))
        a, b = non_idle(doc), non_idle(other)
        if a == b:
            print("MATCH: non-idle counts are identical")
        else:
            print("DIFFER in non-idle counts:")
            for seg in sorted(set(a["seg_stage"]) | set(b["seg_stage"])):
                for st in sorted(set(a["seg_stage"].get(seg, {})) | set(b["seg_stage"].get(seg, {}))):
                    va = insns(a["seg_stage"].get(seg, {}).get(st, 0))
                    vb = insns(b["seg_stage"].get(seg, {}).get(st, 0))
                    if va != vb:
                        print(f"  {seg}/{st}: {va:,} vs {vb:,} (delta {vb - va:+,})")
            if a["frames"] != b["frames"]:
                bad = sum(1 for fa, fb in zip(a["frames"], b["frames"]) if fa != fb)
                print(f"  by_frame: {bad} frame(s) differ")
            sys.exit(1)
    elif "--runs" in args:
        runs_table(doc)
    elif "--frames" in args:
        frames_table(doc)
    else:
        table(doc)


if __name__ == "__main__":
    main()
