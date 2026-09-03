// cases/list-create/app.tsx — Solid variant.
// A keyed list (<For>, keyed by row object identity) of 1000 rows, three
// Texts each. `create` replaces the empty array with 1000 rows in one write,
// `clear` replaces it with an empty array. The signal lives at module scope
// so the protocol object can write it; rows are far taller than the
// viewport, which is fine — layout runs for all of them, paint clips.
import { createSignal, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { GLYPHS, makeRows, ROW_COUNT, type Row } from "./data.ts";

const [rows, setRows] = createSignal<Row[]>([]);
let expected = 0;

export const bench = {
  version: 1,
  case: "list-create",
  actions: ["create", "clear"],
  run(action: string): void {
    if (action === "create") {
      expected = ROW_COUNT;
      setRows(makeRows(ROW_COUNT));
    } else if (action === "clear") {
      expected = 0;
      setRows([]);
    }
  },
  post(action: string): boolean {
    return action === "mount" ? true : rows().length === expected;
  },
  reset(): void {
    expected = 0;
    setRows([]);
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">{`LIST CREATE ${GLYPHS}`}</Text>
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
