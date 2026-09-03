// cases/reactive-diamond/app.vue-vapor.tsx — Vue Vapor variant of app.tsx.
// Same diamond through ref + two computeds.
import { computed, ref } from "vue";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

const COUNT = 32;
const PER_ROW = 8;
const ROW_INDEX = Array.from({ length: COUNT / PER_ROW }, (_, r) => r);
const COL_INDEX = Array.from({ length: PER_ROW }, (_, c) => c);
const TARGET: Record<string, number> = { set: 5, "set-back": 1 };
const src = ref(1);
const branchA = computed(() => src.value * 2);
const branchB = computed(() => src.value + 3);
let target = 1;

export const bench = {
  version: 1,
  case: "reactive-diamond",
  actions: ["set", "set-back"],
  run(action: string): void {
    target = TARGET[action] ?? target;
    src.value = target;
  },
  post(action: string): boolean {
    return action === "mount" ? true : src.value === target;
  },
  reset(): void {
    target = 1;
    src.value = 1;
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">DIAMOND 0123456789:</Text>
      {ROW_INDEX.map((r) => (
        <View class="flex-row gap-1">
          {COL_INDEX.map((c) => (
            <Text class="text-xs text-slate-950 w-[44] h-[10]">{String(branchA.value * branchB.value + r * PER_ROW + c)}</Text>
          ))}
        </View>
      ))}
    </View>
  );
}
