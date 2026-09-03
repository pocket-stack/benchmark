// cases/soak-churn/app.tsx — Solid variant.
// run("churn") arms an onFrame-driven loop: every frame alternates
// "create 200 keyed rows" / "clear", CHURN_FRAMES frames in total, then the
// loop stops and raises the done flag post() reads. Steady-state churn of
// nodes and JS objects — the memory-curve carrier.
import { createSignal, For } from "solid-js";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { Text, View } from "@pocketjs/framework/components";
import { CHURN_FRAMES, GLYPHS, makeRows, ROW_COUNT, type Row } from "./data.ts";

const [rows, setRows] = createSignal<Row[]>([]);
let running = false;
let step = 0;
let done = false;

function churnFrame(): void {
  if (!running) return;
  setRows(step % 2 === 0 ? makeRows(ROW_COUNT) : []);
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
    setRows([]);
  },
};

export default function App() {
  onFrame(churnFrame);
  return (
    <View class="w-full h-full flex-col p-2 gap-1 bg-slate-100">
      <Text class="text-xs text-slate-950 font-bold">{`SOAK CHURN ${GLYPHS}`}</Text>
      <View class="flex-col">
        <For each={rows()}>
          {(row) => (
            <View class="flex-row gap-2 h-[12]">
              <Text class="text-xs text-slate-500 w-[40]">{String(row.id)}</Text>
              <Text class="text-xs text-slate-950 w-[80]">{row.label}</Text>
              <Text class="text-xs text-blue-600 w-[40]">{row.value}</Text>
            </View>
          )}
        </For>
      </View>
    </View>
  );
}
