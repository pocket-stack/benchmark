// cases/list-create/app.vue-vapor.tsx — Vue Vapor variant of app.tsx.
// The rows live in a shallowRef (the array is replaced whole; no per-row
// proxying) and render through the `v-for` directive with `key={row.id}` —
// vue-jsx-vapor compiles that to a keyed `createFor` block; a plain
// `.map()` in JSX would re-create the whole child array instead. Same
// classes, same text, same data as app.tsx.
import { shallowRef } from "vue";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { GLYPHS, makeRows, ROW_COUNT, type Row } from "./data.ts";

const rows = shallowRef<Row[]>([]);
let expected = 0;

export const bench = {
  version: 1,
  case: "list-create",
  actions: ["create", "clear"],
  run(action: string): void {
    if (action === "create") {
      expected = ROW_COUNT;
      rows.value = makeRows(ROW_COUNT);
    } else if (action === "clear") {
      expected = 0;
      rows.value = [];
    }
  },
  post(action: string): boolean {
    return action === "mount" ? true : rows.value.length === expected;
  },
  reset(): void {
    expected = 0;
    rows.value = [];
  },
};

export default function App() {
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">{`LIST CREATE ${GLYPHS}`}</Text>
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
