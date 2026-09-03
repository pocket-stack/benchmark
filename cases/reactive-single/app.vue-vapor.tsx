// cases/reactive-single/app.vue-vapor.tsx — Vue Vapor variant of app.tsx.
// One ref drives one Text; the ref lives at module scope so the protocol
// object can write it. Vue's set gate (Object.is) must swallow `same-value`.
import { ref } from "vue";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

const TARGET: Record<string, string> = { set: "B", "same-value": "B", "set-back": "A" };
const value = ref("A");
let target = "A";

export const bench = {
  version: 1,
  case: "reactive-single",
  actions: ["set", "same-value", "set-back"],
  run(action: string): void {
    target = TARGET[action] ?? target;
    value.value = target;
  },
  post(action: string): boolean {
    return action === "mount" ? true : value.value === target;
  },
  reset(): void {
    target = "A";
    value.value = "A";
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col items-center justify-center gap-2 bg-slate-100">
      <Text class="text-xs text-slate-500 tracking-wide">REACTIVE SINGLE AB</Text>
      <Text class="text-4xl text-slate-950 font-bold">{value.value}</Text>
    </View>
  );
}
