// cases/soak-churn/data.ts — the churned rows, shared by all three variants.
// Fresh arrays on purpose: the churn is create-and-destroy, not reorder.
// Deterministic: no Math.random, no Date.

export interface Row {
  id: number;
  label: string;
  value: string;
}

export const ROW_COUNT = 200;
export const CHURN_FRAMES = 600;

/** Glyph coverage for the baked atlas: every character a row can render. */
export const GLYPHS = "0123456789 Row-";

export function makeRows(count: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const id = i + 1;
    rows.push({ id, label: `Row ${id}`, value: String((id * 37) % 1000) });
  }
  return rows;
}
