// cases/reactive-fanout/app.tsx — Solid variant.
// One signal fans out to 100 Texts, each rendering `${value()}-${index}`:
// one write re-runs 100 independent text effects. The signal lives at module
// scope so the protocol object can write it; the grid itself is static.
import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

const COUNT = 100;
const PER_ROW = 10;
const ROW_INDEX = Array.from({ length: COUNT / PER_ROW }, (_, r) => r);
const COL_INDEX = Array.from({ length: PER_ROW }, (_, c) => c);
const TARGET: Record<string, string> = { set: "B", "set-back": "A" };
const [value, setValue] = createSignal("A");
let target = "A";

export const bench = {
  version: 1,
  case: "reactive-fanout",
  actions: ["set", "set-back"],
  run(action: string): void {
    target = TARGET[action] ?? target;
    setValue(target);
  },
  post(action: string): boolean {
    return action === "mount" ? true : value() === target;
  },
  reset(): void {
    target = "A";
    setValue("A");
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">REACTIVE FANOUT AB-0123456789:</Text>
      {ROW_INDEX.map((r) => (
        <View class="flex-row gap-1">
          {COL_INDEX.map((c) => (
            <Text class="text-xs text-slate-950 w-[44] h-[10]">{`${value()}-${r * PER_ROW + c}`}</Text>
          ))}
        </View>
      ))}
    </View>
  );
}
