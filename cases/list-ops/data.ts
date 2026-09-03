// cases/list-ops/data.ts — the rows and the ABSOLUTE target array of every
// action, shared by all three variants so data and object identity are
// identical by construction. Targets being absolute (not relative to the
// current state) keeps first == steady under every driver, with or without a
// reset between them. Deterministic: no Math.random, no Date.

export interface Row {
  id: number;
  label: string;
  value: string;
}

export const ROW_COUNT = 1000;
const EXTRA_COUNT = 100;
const INSERT_AT = 500;

/** Glyph coverage for the baked atlas: every character a row can render. */
export const GLYPHS = "0123456789 Row-*";

function makeRows(firstId: number, count: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const id = firstId + i;
    rows.push({ id, label: `Row ${id}`, value: String((id * 37) % 1000) });
  }
  return rows;
}

// One set of row objects: unchanged rows keep their identity across targets,
// so identity-keyed renderers (Solid's <For>) and id-keyed renderers see the
// same "which rows are new" facts.
export const BASE: readonly Row[] = makeRows(1, ROW_COUNT);
const APPEND_EXTRA: readonly Row[] = makeRows(2001, EXTRA_COUNT);
const MIDDLE_EXTRA: readonly Row[] = makeRows(3001, EXTRA_COUNT);

const T_APPEND: readonly Row[] = [...BASE, ...APPEND_EXTRA];
const T_INSERT: readonly Row[] = [
  ...BASE.slice(0, INSERT_AT),
  ...MIDDLE_EXTRA,
  ...BASE.slice(INSERT_AT),
  ...APPEND_EXTRA,
];
const T_UPDATE: readonly Row[] = T_INSERT.map((row, index) =>
  index % 10 === 0 ? { id: row.id, label: row.label, value: `${row.value}*` } : row,
);
const T_SWAP: readonly Row[] = (() => {
  const rows = [...T_UPDATE];
  const last = rows.length - 2;
  const kept = rows[1];
  rows[1] = rows[last];
  rows[last] = kept;
  return rows;
})();
const T_REVERSE: readonly Row[] = [...T_SWAP].reverse();
const T_REMOVE: readonly Row[] = T_REVERSE.filter((row) => row.id <= ROW_COUNT);
const T_CLEAR: readonly Row[] = [];

export const TARGETS: Record<string, readonly Row[]> = {
  append: T_APPEND,
  "insert-middle": T_INSERT,
  "update-every-10th": T_UPDATE,
  swap: T_SWAP,
  reverse: T_REVERSE,
  remove: T_REMOVE,
  clear: T_CLEAR,
};

/** The settle check every variant runs: length + first / last id. */
export function matches(length: number, firstId: number, lastId: number, target: readonly Row[]): boolean {
  if (length !== target.length) return false;
  if (target.length === 0) return true;
  return firstId === target[0].id && lastId === target[target.length - 1].id;
}
