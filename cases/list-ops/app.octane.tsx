// cases/list-ops/app.octane.tsx — Octane variant of app.tsx.
// Rows are component state keyed by row id; the component hands its setter
// to module scope once and mirrors the rendered length and first / last id
// there, so post() reads what was actually rendered.
import { useLayoutEffect, useState } from "octane";
import { Text, View } from "@pocketjs/framework/octane/components";
import { BASE, GLYPHS, matches, TARGETS, type Row } from "./data.ts";

let target: readonly Row[] = BASE;
let renderedCount = 0;
let renderedFirst = 0;
let renderedLast = 0;
let setExternal: ((next: readonly Row[]) => void) | null = null;

export const bench = {
  version: 1,
  case: "list-ops",
  actions: ["append", "insert-middle", "update-every-10th", "swap", "reverse", "remove", "clear"],
  run(action: string): void {
    target = TARGETS[action] ?? target;
    if (setExternal) setExternal(target);
  },
  post(action: string): boolean {
    if (action === "mount") return true;
    return matches(renderedCount, renderedFirst, renderedLast, target);
  },
  reset(): void {
    target = BASE;
    if (setExternal) setExternal(BASE);
  },
};

export default function App() {
  const [rows, setRows] = useState<readonly Row[]>(BASE);
  renderedCount = rows.length;
  renderedFirst = rows.length > 0 ? rows[0].id : 0;
  renderedLast = rows.length > 0 ? rows[rows.length - 1].id : 0;
  useLayoutEffect(() => {
    setExternal = setRows;
  }, []);
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">{`LIST OPS ${GLYPHS}`}</Text>
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
