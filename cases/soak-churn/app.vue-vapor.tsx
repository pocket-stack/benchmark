// cases/soak-churn/app.vue-vapor.tsx — Vue Vapor variant of app.tsx.
// Same cadence, same rows; the loop writes a shallowRef rendered through a
// keyed v-for.
import { shallowRef } from "vue";
import { onFrame } from "@pocketjs/framework/vue-vapor/lifecycle";
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { CHURN_FRAMES, GLYPHS, makeRows, ROW_COUNT, type Row } from "./data.ts";

const rows = shallowRef<Row[]>([]);
let running = false;
let step = 0;
let done = false;

function churnFrame(): void {
  if (!running) return;
  rows.value = step % 2 === 0 ? makeRows(ROW_COUNT) : [];
  step += 1;
  if (step >= CHURN_FRAMES) {
    running = false;
    done = true;
  }
}

export const bench = {
  version: 1,
  case: "soak-churn",
  actions: ["churn"],
  run(action: string): void {
    if (action !== "churn") return;
    done = false;
    step = 0;
    running = true;
  },
  post(action: string): boolean {
    return action === "mount" ? true : done;
  },
  reset(): void {
    running = false;
    step = 0;
    done = false;
    rows.value = [];
  },
};

export default function App() {
  onFrame(churnFrame);
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">{`SOAK CHURN ${GLYPHS}`}</Text>
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
