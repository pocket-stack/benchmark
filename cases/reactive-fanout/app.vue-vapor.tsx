// cases/reactive-fanout/app.vue-vapor.tsx — Vue Vapor variant of app.tsx.
// One ref fans out to 100 Texts; the grid is a static `.map()` (positions
// never change), only each Text's interpolation is reactive.
import { ref } from "vue";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

const COUNT = 100;
const PER_ROW = 10;
const ROW_INDEX = Array.from({ length: COUNT / PER_ROW }, (_, r) => r);
const COL_INDEX = Array.from({ length: PER_ROW }, (_, c) => c);
const TARGET: Record<string, string> = { set: "B", "set-back": "A" };
const value = ref("A");
let target = "A";

export const bench = {
  version: 1,
  case: "reactive-fanout",
  actions: ["set", "set-back"],
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
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">REACTIVE FANOUT AB-0123456789:</Text>
      {ROW_INDEX.map((r) => (
        <View class="flex-row gap-1">
          {COL_INDEX.map((c) => (
            <Text class="text-xs text-slate-950 w-[44] h-[10]">{`${value.value}-${r * PER_ROW + c}`}</Text>
          ))}
        </View>
      ))}
    </View>
  );
}
