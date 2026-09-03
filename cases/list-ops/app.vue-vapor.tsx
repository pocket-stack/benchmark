// cases/list-ops/app.vue-vapor.tsx — Vue Vapor variant of app.tsx.
// The rows live in a shallowRef and render through `v-for` with
// `key={row.id}` (a keyed createFor block); every action replaces the array
// with the same absolute target the other variants use.
import { shallowRef } from "vue";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { BASE, GLYPHS, matches, TARGETS, type Row } from "./data.ts";

const rows = shallowRef<readonly Row[]>(BASE);
let target: readonly Row[] = BASE;

export const bench = {
  version: 1,
  case: "list-ops",
  actions: ["append", "insert-middle", "update-every-10th", "swap", "reverse", "remove", "clear"],
  run(action: string): void {
    target = TARGETS[action] ?? target;
    rows.value = target;
  },
  post(action: string): boolean {
    if (action === "mount") return true;
    const current = rows.value;
    const length = current.length;
    return matches(length, length > 0 ? current[0].id : 0, length > 0 ? current[length - 1].id : 0, target);
  },
  reset(): void {
    target = BASE;
    rows.value = BASE;
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">{`LIST OPS ${GLYPHS}`}</Text>
      <View class="flex-col">
        <View v-for={row in rows.value} key={row.id} class="flex-row gap-2 h-[12]">
          <Text class="text-xs text-slate-500 w-[40]">{String(row.id)}</Text>
          <Text class="text-xs text-slate-950 w-[80]">{row.label}</Text>
          <Text class="text-xs text-blue-600 w-[40]">{row.value}</Text>
        </View>
      </View>
    </View>
  );
}
