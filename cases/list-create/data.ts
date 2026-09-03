// cases/list-create/data.ts — the rows, shared by all three variants so the
// data is identical by construction. Deterministic: no Math.random, no Date.

export interface Row {
  id: number;
  label: string;
  value: string;
}

export const ROW_COUNT = 1000;

/** Glyph coverage for the baked atlas: every character a row can render. */
export const GLYPHS = "0123456789 Row-";

export function makeRows(count: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({ id: i + 1, label: `Row ${i + 1}`, value: String((i * 37) % 1000) });
  }
  return rows;
}
