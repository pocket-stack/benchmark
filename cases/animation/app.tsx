// cases/animation/app.tsx — Solid variant.
// 24 bars, each animated by one native translateX tween (300 ms, ease-out):
// JS starts the tween once per action, the Rust core owns every frame after
// that. post() always answers false, so settle is the hash-stability rule —
// the action settles two frames after the tween lands (~20 frames).
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";

const BARS = 24;
const BAR_INDEX = Array.from({ length: BARS }, (_, i) => i);
const DISTANCE = 96;
const DUR = 300;
const bars: Array<NodeMirror | undefined> = [];

export const bench = {
  version: 1,
  case: "animation",
  actions: ["start", "back"],
  run(action: string): void {
    const to = action === "start" ? DISTANCE : 0;
    for (const bar of bars) {
      if (bar) animate(bar, "translateX", to, { dur: DUR, easing: "out" });
    }
  },
  post(action: string): boolean {
    return action === "mount";
  },
  reset(): void {
    for (const bar of bars) {
      if (bar) jump(bar, "translateX", 0);
    }
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">ANIMATION BARS:</Text>
      {BAR_INDEX.map((i) => (
        <View class="w-[240] h-[6] rounded bg-slate-200">
          <View
            ref={(node) => {
              bars[i] = node;
            }}
            class="w-[96] h-[6] rounded bg-blue-500"
          />
        </View>
      ))}
    </View>
  );
}
