// cases/deep-tree/app.tsx — Solid variant.
// A static chain 48 Views deep (left padding + alternating background each
// level, one Text at the bottom): the depth axis of mount cost, still under
// the core's MAX_TREE_DEPTH of 64 counted from the root. No reactive state.
//
// Built bottom-up with a loop, NOT with a recursive component: on the real
// device QuickJS runtime (JS_SetMaxStackSize 256 KB) one component call per
// level overflows the interpreter stack at depth 16 already. Tree depth is a
// native-side axis; the JS call depth must stay flat.
import { Text, View } from "@pocketjs/framework/components";

const DEPTH = 48;
const LEVEL_CLASS = ["flex-col pl-1 bg-slate-200", "flex-col pl-1 bg-slate-300"];

export const bench = {
  version: 1,
  case: "deep-tree",
  actions: ["noop"],
  run(_action: string): void {},
  post(_action: string): boolean {
    return true;
  },
  reset(): void {},
};

export default function App() {
  // Innermost first; every loop turn wraps the chain in one more View. The
  // per-iteration `child` binding keeps any lazily-evaluated JSX child
  // pointing at its own level, not at the loop variable's final value.
  let chain: unknown = <Text class="text-xs text-slate-950">DEEP TREE 48:</Text>;
  for (let level = 1; level <= DEPTH; level++) {
    const child = chain;
    chain = <View class={LEVEL_CLASS[level % 2]}>{child}</View>;
  }
  return <View class="w-full h-full flex-col p-2 bg-slate-100">{chain}</View>;
}
