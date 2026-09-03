// cases/reactive-diamond/app.tsx — Solid variant.
// A diamond: one source signal, two derived memos (A = src*2, B = src+3),
// 32 Texts each rendering A*B + i. One source write must propagate through
// both branches and re-join glitch-free.
import { createMemo, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

const COUNT = 32;
const PER_ROW = 8;
const ROW_INDEX = Array.from({ length: COUNT / PER_ROW }, (_, r) => r);
const COL_INDEX = Array.from({ length: PER_ROW }, (_, c) => c);
const TARGET: Record<string, number> = { set: 5, "set-back": 1 };
const [src, setSrc] = createSignal(1);
const branchA = createMemo(() => src() * 2);
const branchB = createMemo(() => src() + 3);
let target = 1;

export const bench = {
  version: 1,
  case: "reactive-diamond",
  actions: ["set", "set-back"],
  run(action: string): void {
    target = TARGET[action] ?? target;
    setSrc(target);
  },
  post(action: string): boolean {
    return action === "mount" ? true : src() === target;
  },
  reset(): void {
    target = 1;
    setSrc(1);
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">DIAMOND 0123456789:</Text>
      {ROW_INDEX.map((r) => (
        <View class="flex-row gap-1">
          {COL_INDEX.map((c) => (
            <Text class="text-xs text-slate-950 w-[44] h-[10]">{String(branchA() * branchB() + r * PER_ROW + c)}</Text>
          ))}
        </View>
      ))}
    </View>
  );
}
