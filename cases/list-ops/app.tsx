// cases/list-ops/app.tsx — Solid variant.
// A keyed list (<For>, keyed by row object identity) mounted with 1000 rows;
// every action replaces the array with an absolute target from data.ts.
// Unchanged rows keep object identity, so <For> moves or keeps their nodes
// and only genuinely new rows (the extras, the updated every-10th copies)
// are created.
import { createSignal, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { BASE, GLYPHS, matches, TARGETS, type Row } from "./data.ts";

const [rows, setRows] = createSignal<readonly Row[]>(BASE);
let target: readonly Row[] = BASE;

export const bench = {
  version: 1,
  case: "list-ops",
  actions: ["append", "insert-middle", "update-every-10th", "swap", "reverse", "remove", "clear"],
  run(action: string): void {
    target = TARGETS[action] ?? target;
    setRows(target);
  },
  post(action: string): boolean {
    if (action === "mount") return true;
    const current = rows();
    const length = current.length;
    return matches(length, length > 0 ? current[0].id : 0, length > 0 ? current[length - 1].id : 0, target);
  },
  reset(): void {
    target = BASE;
    setRows(BASE);
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">{`LIST OPS ${GLYPHS}`}</Text>
      <View class="flex-col">
        <For each={rows()}>
          {(row) => (
            <View class="flex-row gap-2 h-[12]">
              <Text class="text-xs text-slate-500 w-[40]">{String(row.id)}</Text>
              <Text class="text-xs text-slate-950 w-[80]">{row.label}</Text>
              <Text class="text-xs text-blue-600 w-[40]">{row.value}</Text>
            </View>
          )}
        </For>
      </View>
    </View>
  );
}
