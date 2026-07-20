/** Замкнутый маршрут — периметр кольца cols×rows, обход по часовой стрелке от (0,0). */
export class Track {
  readonly tiles: { c: number; r: number }[] = [];

  constructor(readonly cols: number, readonly rows: number) {
    for (let c = 0; c < cols; c++) this.tiles.push({ c, r: 0 });               // верх →
    for (let r = 1; r < rows; r++) this.tiles.push({ c: cols - 1, r });        // правый ↓
    for (let c = cols - 2; c >= 0; c--) this.tiles.push({ c, r: rows - 1 });   // низ ←
    for (let r = rows - 2; r >= 1; r--) this.tiles.push({ c: 0, r });          // левый ↑
  }

  get length(): number {
    return this.tiles.length;
  }

  /** Позиция в тайловых координатах (float) для progress ∈ [0, length). */
  pos(progress: number): { x: number; y: number } {
    const len = this.length;
    const p = ((progress % len) + len) % len;
    const i = Math.floor(p);
    const f = p - i;
    const a = this.tiles[i];
    const b = this.tiles[(i + 1) % len];
    return { x: a.c + (b.c - a.c) * f, y: a.r + (b.r - a.r) * f };
  }
}
