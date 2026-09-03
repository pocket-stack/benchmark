// cases/mount-static/app.tsx — Solid variant.
// A static tree: 20 rows × 4 coloured cells with a label each — 182 nodes,
// depth 4 — and no reactive state. The single `noop` action does nothing, so
// its cost is the harness floor (frame transaction + hash) on every host.
import { Text, View } from "@pocketjs/framework/components";

const ROWS = 20;
const COLS = 4;
// Full class literals: the Tailwind-subset compiler collects them from source.
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
