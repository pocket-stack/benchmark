// cases/reactive-fanin/app.tsx — Solid variant.
// 100 independent signals fan IN to one Text that shows their sum: one
// source write re-evaluates a single sink that reads all 100. Every action
// writes absolute values, so first == steady with or without a reset.
import { createSignal, type Accessor, type Setter } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";

const COUNT = 100;
const signals: Array<[Accessor<number>, Setter<number>]> = [];
for (let i = 0; i < COUNT; i++) signals.push(createSignal(i));
const EXPECTED: Record<string, number> = { "set-one": 5950, "set-all": 104950, "set-back": 4950 };
let expected = 4950;

function sum(): number {
  let total = 0;
  for (const [get] of signals) total += get();
  return total;
}

export const bench = {
  version: 1,
  case: "reactive-fanin",
  actions: ["set-one", "set-all", "set-back"],
  run(action: string): void {
    expected = EXPECTED[action] ?? expected;
    if (action === "set-one") signals[0][1](1000);
    else if (action === "set-all") signals.forEach(([, set], i) => set(i + 1000));
    else if (action === "set-back") signals.forEach(([, set], i) => set(i));
  },
  post(action: string): boolean {
    return action === "mount" ? true : sum() === expected;
  },
  reset(): void {
    expected = 4950;
    signals.forEach(([, set], i) => set(i));
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col items-center justify-center gap-2 bg-slate-100">
      <Text class="text-xs text-slate-500 tracking-wide">FANIN SUM 0123456789:</Text>
      <Text class="text-4xl text-slate-950 font-bold">{String(sum())}</Text>
    </View>
  );
}
