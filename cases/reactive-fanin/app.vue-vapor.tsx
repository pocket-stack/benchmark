// cases/reactive-fanin/app.vue-vapor.tsx — Vue Vapor variant of app.tsx.
// 100 independent refs fan in to one Text; same absolute writes.
import { ref, type Ref } from "vue";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

const COUNT = 100;
const signals: Array<Ref<number>> = [];
for (let i = 0; i < COUNT; i++) signals.push(ref(i));
const EXPECTED: Record<string, number> = { "set-one": 5950, "set-all": 104950, "set-back": 4950 };
let expected = 4950;

function sum(): number {
  let total = 0;
  for (const source of signals) total += source.value;
  return total;
}

export const bench = {
  version: 1,
  case: "reactive-fanin",
  actions: ["set-one", "set-all", "set-back"],
  run(action: string): void {
    expected = EXPECTED[action] ?? expected;
    if (action === "set-one") signals[0].value = 1000;
    else if (action === "set-all") signals.forEach((source, i) => (source.value = i + 1000));
    else if (action === "set-back") signals.forEach((source, i) => (source.value = i));
  },
  post(action: string): boolean {
    return action === "mount" ? true : sum() === expected;
  },
  reset(): void {
    expected = 4950;
    signals.forEach((source, i) => (source.value = i));
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
