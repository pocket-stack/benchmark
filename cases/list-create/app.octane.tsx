// cases/list-create/app.octane.tsx — Octane variant of app.tsx.
// The rows are component state (useState), keyed by row id. The component
// hands its setter to module scope once and mirrors the rendered row count
// there; the protocol object writes through the setter and reads the mirror.
import { useLayoutEffect, useState } from "octane";
import { Text, View } from "@pocketjs/framework/octane/components";
import { GLYPHS, makeRows, ROW_COUNT, type Row } from "./data.ts";

let expected = 0;
let renderedCount = 0;
let setExternal: ((next: Row[]) => void) | null = null;

export const bench = {
  version: 1,
  case: "list-create",
  actions: ["create", "clear"],
  run(action: string): void {
    if (action === "create") {
      expected = ROW_COUNT;
      if (setExternal) setExternal(makeRows(ROW_COUNT));
    } else if (action === "clear") {
      expected = 0;
      if (setExternal) setExternal([]);
    }
  },
  post(action: string): boolean {
    return action === "mount" ? true : renderedCount === expected;
  },
  reset(): void {
    expected = 0;
    if (setExternal) setExternal([]);
  },
};

export default function App() {
  const [rows, setRows] = useState<Row[]>([]);
  renderedCount = rows.length;
  useLayoutEffect(() => {
    setExternal = setRows;
  }, []);
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">{`LIST CREATE ${GLYPHS}`}</Text>
      <View class="flex-col">
        {rows.map((row) => (
          <View key={row.id} class="flex-row gap-2 h-[12]">
            <Text class="text-xs text-slate-500 w-[40]">{String(row.id)}</Text>
            <Text class="text-xs text-slate-950 w-[80]">{row.label}</Text>
            <Text class="text-xs text-blue-600 w-[40]">{row.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
