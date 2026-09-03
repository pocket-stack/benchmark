// cases/reactive-single/app.tsx — Solid variant.
// One signal drives one Text. `set` writes "B", `same-value` writes "B" again
// (Solid's equality check must swallow it: no HostOps), `set-back` writes "A".
// The signal lives at module scope so the protocol object can write it; the
// component only reads it.
import { createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

const TARGET: Record<string, string> = { set: "B", "same-value": "B", "set-back": "A" };
const [value, setValue] = createSignal("A");
let target = "A";

export const bench = {
  version: 1,
  case: "reactive-single",
  actions: ["set", "same-value", "set-back"],
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
    <View class="w-full h-full flex-col items-center justify-center gap-2 bg-slate-100">
      <Text class="text-xs text-slate-500 tracking-wide">REACTIVE SINGLE AB</Text>
      <Text class="text-4xl text-slate-950 font-bold">{value()}</Text>
    </View>
  );
}
