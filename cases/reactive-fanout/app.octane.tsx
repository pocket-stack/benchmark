// cases/reactive-fanout/app.octane.tsx — Octane variant of app.tsx.
// One useState fans out to 100 Texts through a component re-render. The
// component hands its setter to module scope once and mirrors the rendered
// value there; the protocol object writes the setter and reads the mirror.
import { useLayoutEffect, useState } from "octane";
import { Text, View } from "@pocketjs/framework/octane/components";

const COUNT = 100;
const PER_ROW = 10;
const ROW_INDEX = Array.from({ length: COUNT / PER_ROW }, (_, r) => r);
const COL_INDEX = Array.from({ length: PER_ROW }, (_, c) => c);
const TARGET: Record<string, string> = { set: "B", "set-back": "A" };
let target = "A";
let rendered = "A";
let setExternal: ((next: string) => void) | null = null;

export const bench = {
  version: 1,
  case: "reactive-fanout",
  actions: ["set", "set-back"],
  run(action: string): void {
    target = TARGET[action] ?? target;
    if (setExternal) setExternal(target);
  },
  post(action: string): boolean {
    return action === "mount" ? true : rendered === target;
  },
  reset(): void {
    target = "A";
    if (setExternal) setExternal("A");
  },
};

export default function App() {
  const [value, setValue] = useState("A");
  rendered = value;
  useLayoutEffect(() => {
    setExternal = setValue;
  }, []);
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">REACTIVE FANOUT AB-0123456789:</Text>
      {ROW_INDEX.map((r) => (
        <View key={r} class="flex-row gap-1">
          {COL_INDEX.map((c) => (
            <Text key={c} class="text-xs text-slate-950 w-[44] h-[10]">{`${value}-${r * PER_ROW + c}`}</Text>
          ))}
        </View>
      ))}
    </View>
  );
}
