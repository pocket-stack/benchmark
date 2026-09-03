// cases/reactive-diamond/app.octane.tsx — Octane variant of app.tsx.
// Same diamond: one useState source, two useMemo branches, 32 sinks. The
// component hands its setter to module scope once and mirrors the rendered
// source there.
import { useLayoutEffect, useMemo, useState } from "octane";
import { Text, View } from "@pocketjs/framework/octane/components";

const COUNT = 32;
const PER_ROW = 8;
const ROW_INDEX = Array.from({ length: COUNT / PER_ROW }, (_, r) => r);
const COL_INDEX = Array.from({ length: PER_ROW }, (_, c) => c);
const TARGET: Record<string, number> = { set: 5, "set-back": 1 };
let target = 1;
let rendered = 1;
let setExternal: ((next: number) => void) | null = null;

export const bench = {
  version: 1,
  case: "reactive-diamond",
  actions: ["set", "set-back"],
  run(action: string): void {
    target = TARGET[action] ?? target;
    if (setExternal) setExternal(target);
  },
  post(action: string): boolean {
    return action === "mount" ? true : rendered === target;
  },
  reset(): void {
    target = 1;
    if (setExternal) setExternal(1);
  },
};

export default function App() {
  const [src, setSrc] = useState(1);
  const branchA = useMemo(() => src * 2, [src]);
  const branchB = useMemo(() => src + 3, [src]);
  rendered = src;
  useLayoutEffect(() => {
    setExternal = setSrc;
  }, []);
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">DIAMOND 0123456789:</Text>
      {ROW_INDEX.map((r) => (
        <View key={r} class="flex-row gap-1">
          {COL_INDEX.map((c) => (
            <Text key={c} class="text-xs text-slate-950 w-[44] h-[10]">{String(branchA * branchB + r * PER_ROW + c)}</Text>
          ))}
        </View>
      ))}
    </View>
  );
}
