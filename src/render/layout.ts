/**
 * Grid layout for the multi-pane view.
 *
 * Shared by every renderer *and* the DOM overlay labels, so the chrome always
 * lines up with the GPU scissor rectangles regardless of backend.
 */
export function slotRects(n: number, w: number, h: number) {
  const count = Math.max(1, n);
  const cols = count === 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : count <= 6 ? 3 : 4;
  const rows = Math.ceil(count / cols);
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: (i % cols) * (w / cols),
      y: Math.floor(i / cols) * (h / rows),
      w: w / cols,
      h: h / rows,
    });
  }
  return out;
}

/** Column/row counts for a pane grid, used by renderers that need it. */
export function slotGrid(n: number): { cols: number; rows: number } {
  const count = Math.max(1, n);
  const cols = count === 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : count <= 6 ? 3 : 4;
  return { cols, rows: Math.ceil(count / cols) };
}
