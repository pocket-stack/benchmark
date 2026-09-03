// cases/deep-tree/app.vue-vapor.tsx — Vue Vapor variant of app.tsx.
// Same chain, same classes, same text; built bottom-up with the same loop —
// a recursive component would overflow the device QuickJS stack (256 KB) at
// depth 16, and tree depth is a native-side axis anyway.
import { Text, View } from "@pocketjs/framework/vue-vapor/components";

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
  let chain: unknown = <Text class="text-xs text-slate-950">DEEP TREE 48:</Text>;
  for (let level = 1; level <= DEPTH; level++) {
    const child = chain;
    chain = <View class={LEVEL_CLASS[level % 2]}>{child}</View>;
  }
  return <View class="w-full h-full flex-col p-2 bg-slate-100">{chain}</View>;
}
