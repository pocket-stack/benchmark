// cases/mount-static/app.vue-vapor.tsx — Vue Vapor variant of app.tsx.
// Same tree, same class literals, same text; no reactive state.
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

const ROWS = 20;
const COLS = 4;
const CELL_CLASS = [
  "w-[108] h-[10] rounded bg-blue-500",
  "w-[108] h-[10] rounded bg-emerald-500",
  "w-[108] h-[10] rounded bg-amber-500",
  "w-[108] h-[10] rounded bg-slate-500",
];
const ROW_INDEX = Array.from({ length: ROWS }, (_, r) => r);
const COL_INDEX = Array.from({ length: COLS }, (_, c) => c);

export const bench = {
  version: 1,
  case: "mount-static",
  actions: ["noop"],
  run(_action: string): void {},
  post(_action: string): boolean {
    return true;
  },
  reset(): void {},
};

export default function App() {
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">MOUNT STATIC 0123456789:</Text>
      {ROW_INDEX.map((r) => (
        <View class="flex-row gap-1">
          {COL_INDEX.map((c) => (
            <View class={CELL_CLASS[c]}>
              <Text class="text-xs text-white">{`${r + 1}:${c + 1}`}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
