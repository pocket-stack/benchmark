// cases/reactive-single/app.octane.tsx — Octane variant of app.tsx.
// One useState drives one Text. Hooks are component-scoped, so the component
// hands its setter to module scope once (useLayoutEffect) and mirrors the
// rendered value there; the protocol object writes through the setter and
// reads the mirror. React's setState bail-out must swallow `same-value`.
import { useLayoutEffect, useState } from "octane";
import { Text, View } from "@pocketjs/framework/octane/components";

const TARGET: Record<string, string> = { set: "B", "same-value": "B", "set-back": "A" };
let target = "A";
let rendered = "A";
let setExternal: ((next: string) => void) | null = null;

export const bench = {
  version: 1,
  case: "reactive-single",
  actions: ["set", "same-value", "set-back"],
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
    <View class="w-full h-full flex-col items-center justify-center gap-2 bg-slate-100">
      <Text class="text-xs text-slate-500 tracking-wide">REACTIVE SINGLE AB</Text>
      <Text class="text-4xl text-slate-950 font-bold">{value}</Text>
    </View>
  );
}
