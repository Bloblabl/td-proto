import Phaser from 'phaser';
import { Sim, TILE } from '../core/sim';
import type { Monster, Obstacle, Unit } from '../core/types';
import type { Controls } from '../ui/controls';

interface UnitView {
  container: Phaser.GameObjects.Container;
  rect: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
  typeId: string;
  rank: number;
}

interface MonsterView {
  circle: Phaser.GameObjects.Arc;
  hpBar: Phaser.GameObjects.Rectangle;
}

interface ObstacleView {
  objs: Phaser.GameObjects.GameObject[];
  hpBar?: Phaser.GameObjects.Rectangle;
}

export class GameScene extends Phaser.Scene {
  private unitViews = new Map<number, UnitView>();
  private monsterViews = new Map<number, MonsterView>();
  private obstacleViews = new Map<number, ObstacleView>();
  private fx!: Phaser.GameObjects.Graphics;
  private dragSourceId: number | null = null;

  constructor(private sim: Sim, private controls: Controls) {
    super('game');
  }

  create(): void {
    const { cfg } = this.sim;

    // трек
    for (const t of this.sim.track.tiles) {
      this.add.rectangle(t.c * TILE + TILE / 2, t.r * TILE + TILE / 2, TILE - 2, TILE - 2, 0x2c2f36)
        .setStrokeStyle(1, 0x3a3d44);
    }
    // клетки поля
    const g = this.sim.gridOriginPx();
    for (let i = 0; i < this.sim.gridCells; i++) {
      const c = i % cfg.grid.cols, r = Math.floor(i / cfg.grid.cols);
      this.add.rectangle(g.x + c * TILE + TILE / 2, g.y + r * TILE + TILE / 2, TILE - 4, TILE - 4, 0x41454f)
        .setStrokeStyle(1, 0x565b66);
    }

    this.fx = this.add.graphics().setDepth(10);

    // взведённые действия: установка заграждения / прицел метеора
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const armed = this.controls.armed;
      if (!armed) return;
      if (armed.kind === 'obstacle') {
        const tile = this.sim.trackTileAt(p.worldX, p.worldY);
        if (tile !== null && this.sim.placeObstacle(armed.ob, tile)) this.controls.armed = null;
      } else if (this.sim.useBoost('meteor', p.worldX, p.worldY)) {
        this.controls.armed = null;
      }
    });

    // drag-мердж
    this.input.on('dragstart', (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      this.dragSourceId = obj.getData('unitId') as number;
      (obj as Phaser.GameObjects.Container).setDepth(20);
    });
    this.input.on('drag', (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject, x: number, y: number) => {
      (obj as Phaser.GameObjects.Container).setPosition(x, y);
    });
    this.input.on('dragend', (p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      const srcId = this.dragSourceId;
      this.dragSourceId = null;
      (obj as Phaser.GameObjects.Container).setDepth(1);
      if (srcId == null) return;
      const targetId = this.unitIdAt(p.worldX, p.worldY, srcId);
      if (targetId != null) this.sim.merge(srcId, targetId);
      this.syncUnits(true); // вернуть/пересобрать позиции
    });
  }

  update(): void {
    this.syncUnits(false);
    this.syncMonsters();
    this.syncObstacles();
    this.drawFx();
  }

  private syncObstacles(): void {
    const seen = new Set<number>();
    for (const o of this.sim.obstacles) {
      seen.add(o.id);
      let v = this.obstacleViews.get(o.id);
      if (!v) {
        v = this.createObstacleView(o);
        this.obstacleViews.set(o.id, v);
      }
      if (o.kind === 'barricade' && v.hpBar) {
        const p = this.sim.trackTilePx(o.tile);
        const w = TILE - 12;
        const frac = Math.max(0, (o.hp ?? 0) / (o.maxHp ?? 1));
        v.hpBar.width = Math.max(1, w * frac);
        v.hpBar.setPosition(p.x - w / 2 + (w * frac) / 2, p.y - TILE / 2 + 5);
      }
    }
    for (const [id, v] of this.obstacleViews) {
      if (!seen.has(id)) {
        for (const obj of v.objs) obj.destroy();
        this.obstacleViews.delete(id);
      }
    }
  }

  private createObstacleView(o: Obstacle): ObstacleView {
    const p = this.sim.trackTilePx(o.tile);
    if (o.kind === 'barricade') {
      const rect = this.add.rectangle(p.x, p.y, TILE - 14, TILE - 18, 0x8b5a2b)
        .setStrokeStyle(2, 0xc9915a).setDepth(4);
      const hpBar = this.add.rectangle(p.x, p.y - TILE / 2 + 5, TILE - 12, 3, 0x4caf50).setDepth(6);
      return { objs: [rect, hpBar], hpBar };
    }
    if (o.kind === 'spikes') {
      const rect = this.add.rectangle(p.x, p.y, TILE - 16, TILE - 16, 0x565b66, 0.9).setDepth(3);
      const label = this.add.text(p.x, p.y, '▲▲', {
        fontFamily: 'system-ui', fontSize: '14px', color: '#ffd45e'
      }).setOrigin(0.5).setDepth(4);
      return { objs: [rect, label] };
    }
    // слоу-зона: накрывает несколько тайлов подряд
    const len = this.sim.track.length;
    const n = this.sim.cfg.obstacles.slowzone.tiles;
    const objs: Phaser.GameObjects.GameObject[] = [];
    for (let i = 0; i < n; i++) {
      const tp = this.sim.trackTilePx((o.tile + i) % len);
      objs.push(this.add.rectangle(tp.x, tp.y, TILE - 6, TILE - 6, 0x67e8f9, 0.25).setDepth(2));
    }
    return { objs };
  }

  private unitIdAt(x: number, y: number, excludeId: number): number | null {
    for (const u of this.sim.units) {
      if (u.id === excludeId) continue;
      const p = this.sim.cellPx(u.cell);
      if (Math.abs(x - p.x) <= TILE / 2 && Math.abs(y - p.y) <= TILE / 2) return u.id;
    }
    return null;
  }

  private syncUnits(force: boolean): void {
    const seen = new Set<number>();
    for (const u of this.sim.units) {
      seen.add(u.id);
      let v = this.unitViews.get(u.id);
      if (!v) {
        v = this.createUnitView(u);
        this.unitViews.set(u.id, v);
      }
      if (force || v.typeId !== u.typeId || v.rank !== u.rank) {
        const t = this.sim.unitType(u.typeId);
        v.rect.setFillStyle(Phaser.Display.Color.HexStringToColor(t.color).color);
        v.label.setText(String(u.rank));
        v.typeId = u.typeId;
        v.rank = u.rank;
        const p = this.sim.cellPx(u.cell);
        v.container.setPosition(p.x, p.y);
      }
      if (this.dragSourceId !== u.id && !this.input.activePointer.isDown) {
        const p = this.sim.cellPx(u.cell);
        v.container.setPosition(p.x, p.y);
      }
    }
    for (const [id, v] of this.unitViews) {
      if (!seen.has(id)) {
        v.container.destroy();
        this.unitViews.delete(id);
      }
    }
  }

  private createUnitView(u: Unit): UnitView {
    const t = this.sim.unitType(u.typeId);
    const p = this.sim.cellPx(u.cell);
    const rect = this.add.rectangle(0, 0, TILE - 10, TILE - 10,
      Phaser.Display.Color.HexStringToColor(t.color).color).setStrokeStyle(2, 0xffffff, 0.6);
    const label = this.add.text(0, 0, String(u.rank), {
      fontFamily: 'system-ui', fontSize: '20px', fontStyle: 'bold', color: '#1b1d22'
    }).setOrigin(0.5);
    const container = this.add.container(p.x, p.y, [rect, label]).setDepth(1);
    container.setSize(TILE - 10, TILE - 10);
    container.setInteractive({ draggable: true, useHandCursor: true });
    container.setData('unitId', u.id);
    return { container, rect, label, typeId: u.typeId, rank: u.rank };
  }

  private syncMonsters(): void {
    const seen = new Set<number>();
    for (const m of this.sim.monsters) {
      seen.add(m.id);
      let v = this.monsterViews.get(m.id);
      if (!v) {
        v = this.createMonsterView(m);
        this.monsterViews.set(m.id, v);
      }
      const p = this.sim.monsterPx(m);
      v.circle.setPosition(p.x, p.y);
      const frac = Math.max(0, m.hp / m.maxHp);
      v.hpBar.setPosition(p.x - m.type.radius + m.type.radius * frac, p.y - m.type.radius - 5);
      v.hpBar.width = Math.max(1, 2 * m.type.radius * frac);
      const slowed = this.sim.time < m.slowUntil;
      const poisoned = m.dotDps > 0 && this.sim.time < m.dotUntil;
      v.circle.setStrokeStyle(
        slowed || poisoned ? 3 : 0,
        poisoned ? 0x22c55e : 0x67e8f9
      );
    }
    for (const [id, v] of this.monsterViews) {
      if (!seen.has(id)) {
        v.circle.destroy();
        v.hpBar.destroy();
        this.monsterViews.delete(id);
      }
    }
  }

  private createMonsterView(m: Monster): MonsterView {
    const color = Phaser.Display.Color.HexStringToColor(m.type.color).color;
    const circle = this.add.circle(0, 0, m.type.radius, color).setDepth(5);
    const hpBar = this.add.rectangle(0, 0, m.type.radius * 2, 3, 0x4caf50).setDepth(6);
    return { circle, hpBar };
  }

  private drawFx(): void {
    this.fx.clear();
    const now = this.sim.time;
    for (const e of this.sim.attackEvents) {
      const age = now - e.t;
      if (age < 0 || age > 0.12) continue;
      const from = e.fromX !== undefined && e.fromY !== undefined
        ? { x: e.fromX, y: e.fromY }
        : this.sim.cellPx(e.fromCell);
      const color = Phaser.Display.Color.HexStringToColor(e.color).color;
      this.fx.lineStyle(2, color, 1 - age / 0.12);
      this.fx.lineBetween(from.x, from.y, e.x, e.y);
      if (e.aoeRadiusPx) {
        this.fx.strokeCircle(e.x, e.y, e.aoeRadiusPx * (0.6 + age * 3));
      }
    }
    this.sim.attackEvents = this.sim.attackEvents.filter(e => now - e.t <= 0.2);

    // взрыв метеора
    for (const e of this.sim.blastEvents) {
      const age = now - e.t;
      if (age < 0 || age > 0.6) continue;
      const k = age / 0.6;
      const r = e.radiusPx * (0.35 + 0.65 * k);
      this.fx.fillStyle(0xff6a00, 0.3 * (1 - k));
      this.fx.fillCircle(e.x, e.y, r);
      this.fx.lineStyle(3 * (1 - k) + 1, 0xffaa33, 1 - k);
      this.fx.strokeCircle(e.x, e.y, r);
    }
    this.sim.blastEvents = this.sim.blastEvents.filter(e => now - e.t <= 1);

    // подсказки взведённого действия
    const armed = this.controls.armed;
    if (armed) {
      if (armed.kind === 'obstacle') {
        this.fx.fillStyle(0x4caf50, 0.16);
        for (const t of this.sim.track.tiles) {
          this.fx.fillRect(t.c * TILE + 2, t.r * TILE + 2, TILE - 4, TILE - 4);
        }
      } else {
        const p = this.input.activePointer;
        this.fx.lineStyle(2, 0xff5533, 0.9);
        this.fx.strokeCircle(p.worldX, p.worldY, (this.sim.boostCfg('meteor').radiusTiles ?? 2) * TILE);
      }
    }
  }
}
