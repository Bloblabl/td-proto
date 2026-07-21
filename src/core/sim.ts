import { critStats, emptyMeta, towerDamageBonus } from './meta';
import { Rng } from './rng';
import { Track } from './track';
import type {
  AttackEvent, BalanceCfg, BlastEvent, BoostCfg, BoostId, BoostState, DraftCard, MetaState, Monster,
  MonsterTypeCfg, Obstacle, ObstacleKind, RunStats, Unit, UnitTypeCfg, WaveGroup, WaveStats, WavesCfg
} from './types';

export const TILE = 56; // px, единый масштаб для симуляции AoE и рендера

interface SpawnEntry { at: number; type: MonsterTypeCfg; hpMult: number; }

export type Phase = 'combat' | 'intermission';

export class Sim {
  readonly track: Track;
  readonly rng: Rng;

  time = 0;
  mana: number;
  lives: number;
  wave = 0;
  gameOver = false;
  godMode = false;

  /** Фаза: intermission — пауза между волнами (сюда встанет драфт этапа 4). */
  phase: Phase = 'combat';
  intermissionEndsAt = 0;

  monsters: Monster[] = [];
  units: Unit[] = [];
  obstacles: Obstacle[] = [];
  /** Колода забега: 5 из 7 типов */
  readonly deck: UnitTypeCfg[];
  /** Уровень in-match апгрейда по типу колоды (с 1) */
  typeLevels: Record<string, number> = {};
  summonCount = 0;

  /** Драфт: пока карточки не выбраны — симуляция стоит */
  draftPending: DraftCard[] | null = null;
  private lastDraftAtWave = 0;

  // накопленные эффекты драфта
  private typeDamageBonus: Record<string, number> = {};
  private boostCdMult = 1;
  private manaKillBonus = 0;
  private rank2Summons = 0;

  /** Инвентарь заграждений (расходники) */
  inventory: Record<ObstacleKind, number>;
  /** Селекторы направленного мерджа и выбранный тип для следующего мерджа */
  selectors: number;
  selectorType: string | null = null;

  boosts: BoostState[];
  overdriveUntil = 0;

  /** События атак/взрывов для рендера (обрезаются по времени) */
  attackEvents: AttackEvent[] = [];
  blastEvents: BlastEvent[] = [];

  readonly stats: RunStats;

  private spawnQueue: SpawnEntry[] = [];
  private waveStartedAt = 0;
  private nextId = 1;
  private unitTypeById = new Map<string, UnitTypeCfg>();
  private monsterTypeById = new Map<string, MonsterTypeCfg>();
  private boostById = new Map<BoostId, BoostCfg>();

  /** Аккумулятор статистики текущей волны (снимается в stats.waves на её конце) */
  private waveAcc = { manaEarned: 0, manaSpentSummon: 0, manaSpentUpgrade: 0, manaFromGen: 0, merges: 0, kills: 0 };
  /** Скользящее окно урона для DPS-оверлея: 10 посекундных корзин на источник */
  private dpsBuckets = new Map<string, number[]>();
  private dpsLastSec = 0;

  /** Мета-прогрессия игрока: уровни башен и общий крит (readonly в бою). */
  readonly meta: MetaState;
  readonly critChance: number;
  readonly critMult: number;

  constructor(
    readonly cfg: BalanceCfg,
    readonly waves: WavesCfg,
    readonly seed: number,
    deckIds?: string[],
    readonly mode: string = 'arcade',
    meta?: MetaState
  ) {
    this.rng = new Rng(seed);
    this.meta = meta ?? emptyMeta(cfg);
    const crit = critStats(cfg, this.meta);
    this.critChance = crit.chance;
    this.critMult = crit.mult;
    this.track = new Track(cfg.track.cols, cfg.track.rows);
    this.mana = cfg.startMana;
    this.lives = cfg.lives;
    for (const u of cfg.unitTypes) this.unitTypeById.set(u.id, u);
    const ids = deckIds && deckIds.length === cfg.deckSize && deckIds.every(id => this.unitTypeById.has(id))
      ? deckIds
      : cfg.unitTypes.slice(0, cfg.deckSize).map(t => t.id);
    this.deck = ids.map(id => this.unitTypeById.get(id)!);
    for (const t of this.deck) this.typeLevels[t.id] = 1;
    for (const m of cfg.monsterTypes) this.monsterTypeById.set(m.id, m);
    this.inventory = { ...cfg.obstacles.startInventory };
    this.selectors = cfg.selectorStart;
    this.boosts = cfg.boosts.map(b => {
      this.boostById.set(b.id, b);
      // кулдауны стартуют частично заряженными
      return { id: b.id, readyAt: b.cooldown * (1 - cfg.boostStartCharge) };
    });
    this.stats = {
      seed, mode, wavesReached: 0, timeSec: 0, kills: 0, merges: 0, summons: 0,
      manaEarned: 0, manaSpentSummon: 0, manaSpentUpgrade: 0, manaFromGen: 0,
      damageByType: {}, overkillByType: {}, waves: [], boostsUsed: {},
      critHits: 0, totalHits: 0, critBonusDamage: 0, currencyEarned: 0,
      timeBought: { barricade: 0, slowzone: 0 },
      obstaclesPlaced: {}, selectorsUsed: 0, draftPicks: []
    };
    this.startNextWave();
  }

  // ---------- публичное API (вызывается из UI) ----------

  get gridCells(): number {
    return this.cfg.grid.cols * this.cfg.grid.rows;
  }

  get summonCost(): number {
    return this.cfg.summon.baseCost + this.cfg.summon.costStep * this.summonCount;
  }

  unitType(id: string): UnitTypeCfg {
    const t = this.unitTypeById.get(id);
    if (!t) throw new Error(`unknown unit type ${id}`);
    return t;
  }

  /** Призыв случайного юнита колоды ранга 1 (или 2 — эффект драфта) на случайную свободную клетку. */
  summon(): boolean {
    if (this.gameOver) return false;
    const cost = this.summonCost;
    if (this.mana < cost) return false;
    const free: number[] = [];
    const occupied = new Set(this.units.map(u => u.cell));
    for (let i = 0; i < this.gridCells; i++) if (!occupied.has(i)) free.push(i);
    if (free.length === 0) return false;
    const cell = this.rng.pick(free);
    const type = this.rng.pick(this.deck);
    this.mana -= cost;
    this.stats.manaSpentSummon += cost;
    this.waveAcc.manaSpentSummon += cost;
    this.summonCount++;
    this.stats.summons++;
    let rank = 1;
    if (this.rank2Summons > 0) { rank = 2; this.rank2Summons--; }
    this.units.push({ id: this.nextId++, typeId: type.id, rank, cell, cooldown: type.period * 0.5 });
    return true;
  }

  /**
   * Мердж: source перетащен на target. Тот же тип и ранг → target становится рангом+1.
   * Тип — случайный из колоды; если взведён Селектор — выбранный игроком (селектор расходуется).
   */
  merge(sourceId: number, targetId: number): boolean {
    if (this.gameOver) return false;
    const a = this.units.find(u => u.id === sourceId);
    const b = this.units.find(u => u.id === targetId);
    if (!a || !b || a.id === b.id) return false;
    if (a.typeId !== b.typeId || a.rank !== b.rank) return false;
    if (a.rank >= this.cfg.maxRank) return false;
    if (this.selectorType !== null && this.selectors > 0) {
      b.typeId = this.selectorType;
      this.selectors--;
      this.selectorType = null;
      this.stats.selectorsUsed++;
    } else {
      b.typeId = this.rng.pick(this.deck).id;
    }
    b.rank = a.rank + 1;
    b.cooldown = this.effPeriod(b) * 0.5;
    this.units = this.units.filter(u => u.id !== a.id);
    this.stats.merges++;
    this.waveAcc.merges++;
    return true;
  }

  /** Взвести/снять Селектор: следующий мердж даст выбранный тип (из колоды). */
  armSelector(typeId: string | null): boolean {
    if (typeId === null) { this.selectorType = null; return true; }
    if (this.selectors <= 0 || !this.deck.some(t => t.id === typeId)) return false;
    this.selectorType = typeId;
    return true;
  }

  // ---------- драфт (режим «Аркада») ----------

  /** Применить выбранную карточку и продолжить забег. */
  pickDraft(index: number): boolean {
    if (!this.draftPending || index < 0 || index >= this.draftPending.length) return false;
    const card = this.draftPending[index];
    const e = card.entry;
    if (e.kind === 'typeDamage' && card.typeId) {
      this.typeDamageBonus[card.typeId] =
        (this.typeDamageBonus[card.typeId] ?? 0) + this.cfg.draft.typeDamagePct;
    } else if (e.kind === 'selector') {
      this.selectors += e.n;
    } else if (e.kind === 'obstacle') {
      this.inventory[e.ob] += e.n;
    } else if (e.kind === 'boostCooldown') {
      this.boostCdMult *= 1 - e.pct;
    } else if (e.kind === 'manaKill') {
      this.manaKillBonus += e.pct;
    } else if (e.kind === 'rank2Summon') {
      this.rank2Summons += e.n;
    }
    this.stats.draftPicks.push({ wave: this.wave, title: card.title });
    this.draftPending = null;
    this.phase = 'intermission';
    this.intermissionEndsAt = this.time + this.cfg.intermissionSec;
    return true;
  }

  /** Пул раскрывается по колоде: карточка «+урон типу» на каждый из 5 типов + 7 общих = 12. */
  private generateDraft(): DraftCard[] {
    const cards: DraftCard[] = [];
    const pct = Math.round(this.cfg.draft.typeDamagePct * 100);
    for (const e of this.cfg.draft.pool) {
      if (e.kind === 'typeDamage') {
        for (const t of this.deck) {
          const word = t.targeting === 'none' ? 'эффекта' : 'урона';
          cards.push({ title: `+${pct}% ${word}: ${t.name}`, entry: e, typeId: t.id });
        }
      } else if (e.kind === 'selector') {
        cards.push({ title: `+${e.n} Селектор`, entry: e });
      } else if (e.kind === 'obstacle') {
        const nm = e.ob === 'barricade' ? 'Баррикада' : e.ob === 'spikes' ? 'Шипы' : 'Слоу-зона';
        cards.push({ title: `+${e.n} ${nm}`, entry: e });
      } else if (e.kind === 'boostCooldown') {
        cards.push({ title: `−${Math.round(e.pct * 100)}% кулдауна бустов`, entry: e });
      } else if (e.kind === 'manaKill') {
        cards.push({ title: `+${Math.round(e.pct * 100)}% маны с убийств`, entry: e });
      } else {
        cards.push({ title: `Следующие ${e.n} призыва — ранг 2`, entry: e });
      }
    }
    // выбор N разных карточек (частичный Фишер–Йетс на сиде забега)
    for (let i = 0; i < Math.min(this.cfg.draft.choices, cards.length); i++) {
      const j = i + this.rng.int(cards.length - i);
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    return cards.slice(0, this.cfg.draft.choices);
  }

  // ---------- заграждения ----------

  activeObstacles(kind: ObstacleKind): number {
    return this.obstacles.filter(o => o.kind === kind).length;
  }

  canPlaceObstacle(kind: ObstacleKind): boolean {
    if (this.gameOver || this.inventory[kind] <= 0) return false;
    const max = kind === 'barricade' ? this.cfg.obstacles.barricade.maxActive
      : kind === 'spikes' ? this.cfg.obstacles.spikes.maxActive
      : this.cfg.obstacles.slowzone.maxActive;
    return this.activeObstacles(kind) < max;
  }

  /** Поставить заграждение на тайл трека [0, track.length). */
  placeObstacle(kind: ObstacleKind, tile: number): boolean {
    if (!this.canPlaceObstacle(kind)) return false;
    if (tile < 0 || tile >= this.track.length) return false;
    if (this.obstacles.some(o => o.kind === kind && o.tile === tile)) return false;
    const ob: Obstacle = { id: this.nextId++, kind, tile };
    const c = this.cfg.obstacles;
    if (kind === 'barricade') {
      ob.hp = c.barricade.hp;
      ob.maxHp = c.barricade.hp;
    } else if (kind === 'spikes') {
      ob.expiresAt = this.time + c.spikes.duration;
      ob.nextTickAt = this.time + c.spikes.period;
    } else {
      ob.expiresAt = this.time + c.slowzone.duration;
    }
    this.obstacles.push(ob);
    this.inventory[kind]--;
    this.stats.obstaclesPlaced[kind] = (this.stats.obstaclesPlaced[kind] ?? 0) + 1;
    return true;
  }

  addObstacles(kind: ObstacleKind, n: number): void {
    this.inventory[kind] += n;
  }

  // ---------- бусты ----------

  boostCfg(id: BoostId): BoostCfg {
    const b = this.boostById.get(id);
    if (!b) throw new Error(`unknown boost ${id}`);
    return b;
  }

  boostReadyIn(id: BoostId): number {
    const s = this.boosts.find(b => b.id === id)!;
    return Math.max(0, s.readyAt - this.time);
  }

  /** Активировать буст. Для метеора нужны координаты цели в px. */
  useBoost(id: BoostId, x?: number, y?: number): boolean {
    if (this.gameOver) return false;
    const state = this.boosts.find(b => b.id === id)!;
    if (this.time < state.readyAt) return false;
    const cfg = this.boostCfg(id);
    if (id === 'meteor') {
      if (x === undefined || y === undefined) return false;
      const rPx = (cfg.radiusTiles ?? 2) * TILE;
      for (const m of this.monsters) {
        const p = this.monsterPx(m);
        const dx = p.x - x, dy = p.y - y;
        if (dx * dx + dy * dy <= rPx * rPx) this.hit(m, cfg.damage ?? 0, 'meteor');
      }
      this.blastEvents.push({ t: this.time, x, y, radiusPx: rPx });
    } else if (id === 'overdrive') {
      this.overdriveUntil = this.time + (cfg.duration ?? 0);
    } else {
      this.addMana(cfg.mana ?? 0);
    }
    state.readyAt = this.time + cfg.cooldown * this.boostCdMult;
    (this.stats.boostsUsed[id] ??= []).push({ wave: this.wave, time: Math.round(this.time) });
    return true;
  }

  /** In-match апгрейд типа: +multPerLevel к базовому урону/эффекту всем юнитам типа. */
  upgradeTypeCost(typeId: string): number | null {
    const level = this.typeLevels[typeId];
    if (level === undefined) return null; // тип не в колоде
    const costs = this.cfg.typeUpgrade.costs;
    if (level - 1 >= costs.length) return null; // максимум
    return costs[level - 1];
  }

  upgradeType(typeId: string): boolean {
    if (this.gameOver) return false;
    const cost = this.upgradeTypeCost(typeId);
    if (cost === null || this.mana < cost) return false;
    this.mana -= cost;
    this.stats.manaSpentUpgrade += cost;
    this.waveAcc.manaSpentUpgrade += cost;
    this.typeLevels[typeId]++;
    return true;
  }

  /** Ручной вызов следующей волны — бонус маны за риск; отменяет паузу между волнами. */
  callNextWave(): void {
    if (this.gameOver || this.draftPending) return;
    this.phase = 'combat';
    this.addMana(this.cfg.earlyWaveBonus);
    this.startNextWave();
  }

  addMana(n: number): void {
    this.mana += n;
    this.stats.manaEarned += n;
    this.waveAcc.manaEarned += n;
  }

  /** DPS по источникам за последние 10 секунд (для дебаг-оверлея). */
  dpsByType(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [id, arr] of this.dpsBuckets) {
      const sum = arr.reduce((s, v) => s + v, 0);
      if (sum > 0) out[id] = sum / 10;
    }
    return out;
  }

  /** Debug: прыжок на волну N (текущие монстры и очередь спавна очищаются). */
  jumpToWave(n: number): void {
    if (this.gameOver || n < 1) return;
    this.monsters = [];
    this.spawnQueue = [];
    this.draftPending = null;
    this.phase = 'combat';
    this.wave = n - 1;
    this.startNextWave();
  }

  killAllMonsters(): void {
    for (const m of this.monsters) this.reward(m);
    this.monsters = [];
    this.spawnQueue = [];
  }

  // ---------- тик симуляции ----------

  tick(dt: number): void {
    if (this.gameOver || this.draftPending) return; // драфт: полная пауза
    this.time += dt;
    this.stats.timeSec = this.time;

    // ротация корзин DPS-окна (новая секунда → обнулить свою ячейку)
    const sec = Math.floor(this.time);
    if (sec !== this.dpsLastSec) {
      this.dpsLastSec = sec;
      for (const arr of this.dpsBuckets.values()) arr[sec % 10] = 0;
    }

    // конец паузы между волнами
    if (this.phase === 'intermission' && this.time >= this.intermissionEndsAt) {
      this.phase = 'combat';
      this.startNextWave();
    }

    // спавн
    while (this.spawnQueue.length > 0 && this.spawnQueue[0].at <= this.time) {
      const e = this.spawnQueue.shift()!;
      this.monsters.push({
        id: this.nextId++,
        type: e.type,
        hp: e.type.hp * e.hpMult,
        maxHp: e.type.hp * e.hpMult,
        progress: 0,
        travelled: 0,
        slowPct: 0,
        slowUntil: 0,
        dotDps: 0,
        dotUntil: 0,
        dotSrc: ''
      });
    }

    // движение: слоу (мороз + зоны), баррикады, круги
    const trackLen = this.track.length;
    const barricades = this.obstacles.filter(o => o.kind === 'barricade');
    const zones = this.obstacles.filter(o => o.kind === 'slowzone');
    const zoneCfg = this.cfg.obstacles.slowzone;
    const survivors: Monster[] = [];
    for (const m of this.monsters) {
      // правило стакинга: max по величине из мороза и зоны, кап — общий по типу монстра
      const frostSlow = this.time < m.slowUntil ? m.slowPct : 0;
      let zoneSlow = 0;
      const tile = Math.floor(m.progress) % trackLen;
      for (const z of zones) {
        if (((tile - z.tile) % trackLen + trackLen) % trackLen < zoneCfg.tiles) {
          zoneSlow = m.type.id === 'boss' ? zoneCfg.bossSlowPct : zoneCfg.slowPct;
          break;
        }
      }
      const slow = Math.min(Math.max(frostSlow, zoneSlow), m.type.slowCap ?? 1);
      if (zoneSlow > 0 && zoneSlow >= frostSlow) this.stats.timeBought.slowzone += slow * dt;
      let step = m.type.speed * (1 - slow) * dt;

      // ближайшая баррикада впереди: монстр останавливается перед ней и бьёт её
      let blockDist = Infinity;
      let blocker: Obstacle | null = null;
      for (const b of barricades) {
        let d = b.tile - m.progress;
        if (this.cfg.lapsDamage) d = ((d % trackLen) + trackLen) % trackLen;
        else if (d < -0.001) continue; // «прошёл — исчез»: за спиной не считается
        if (d < blockDist) { blockDist = d; blocker = b; }
      }
      if (blocker && blockDist <= step) {
        step = Math.max(0, blockDist);
        blocker.hp = (blocker.hp ?? 0) - this.cfg.obstacles.barricade.monsterDps * dt;
        this.stats.timeBought.barricade += dt;
      }

      m.progress += step;
      m.travelled += step;
      let removed = false;
      while (m.progress >= trackLen) {
        m.progress -= trackLen;
        if (!this.godMode) this.lives--;
        if (!this.cfg.lapsDamage) { removed = true; break; } // режим «прошёл — исчез»
      }
      if (!removed) survivors.push(m);
    }
    this.monsters = survivors;
    if (this.lives <= 0) {
      this.gameOver = true;
      return;
    }

    // шипы: периодический урон по монстрам на своём тайле
    const spikeCfg = this.cfg.obstacles.spikes;
    for (const o of this.obstacles) {
      if (o.kind !== 'spikes') continue;
      while (o.nextTickAt !== undefined && this.time >= o.nextTickAt && this.time <= (o.expiresAt ?? 0)) {
        for (const m of this.monsters) {
          if (Math.floor(m.progress) % trackLen === o.tile) this.hit(m, spikeCfg.damage, 'spikes');
        }
        o.nextTickAt += spikeCfg.period;
      }
    }

    // удаление заграждений: истёкшие и разбитые
    this.obstacles = this.obstacles.filter(o =>
      (o.expiresAt === undefined || this.time < o.expiresAt) &&
      (o.hp === undefined || o.hp > 0)
    );

    // яд: тики DoT
    for (const m of this.monsters) {
      if (m.dotDps > 0 && this.time < m.dotUntil) this.hit(m, m.dotDps * dt, m.dotSrc);
    }

    // атаки юнитов
    for (const u of this.units) {
      u.cooldown -= dt;
      if (u.cooldown > 0) continue;
      const t = this.unitType(u.typeId);
      if (t.targeting === 'none') {
        // генератор: доход масштабируется апгрейдом типа и драфтом, как урон у боевых
        const income = (t.manaAmount ?? 0) * this.effMult(u);
        this.addMana(income);
        this.stats.manaFromGen += income;
        this.waveAcc.manaFromGen += income;
        u.cooldown += this.effPeriod(u);
        continue;
      }
      const target = this.acquire(t.targeting);
      if (!target) { u.cooldown = 0; continue; } // ждём цель, не копим отрицательный кулдаун
      // крит роллится один раз на атаку: критует весь залп, а не отдельные цели
      const baseDmg = this.effDamage(u, t);
      const isCrit = this.rng.next() < this.critChance;
      const dmg = isCrit ? baseDmg * this.critMult : baseDmg;
      this.stats.totalHits++;
      if (isCrit) {
        this.stats.critHits++;
        this.stats.critBonusDamage += dmg - baseDmg; // номинальный бонус, без учёта overkill
      }
      const pos = this.monsterPx(target);
      if (t.aoeRadius) {
        const rPx = t.aoeRadius * TILE;
        for (const m of this.monsters) {
          const p = this.monsterPx(m);
          const dx = p.x - pos.x, dy = p.y - pos.y;
          if (dx * dx + dy * dy <= rPx * rPx) this.hit(m, dmg, t.id);
        }
      } else {
        this.hit(target, dmg, t.id);
      }
      if (t.slowPct && t.slowDur) {
        target.slowPct = Math.max(target.slowPct, t.slowPct);
        target.slowUntil = this.time + t.slowDur;
      }
      if (t.dotDps && t.dotDur) {
        // яд: DoT масштабируется теми же бонусами, что и прямой урон
        target.dotDps = Math.max(target.dotDps, t.dotDps * this.effMult(u));
        target.dotUntil = this.time + t.dotDur;
        target.dotSrc = t.id;
      }
      this.attackEvents.push({
        t: this.time, fromCell: u.cell, x: pos.x, y: pos.y, color: t.color,
        aoeRadiusPx: t.aoeRadius ? t.aoeRadius * TILE : undefined,
        crit: isCrit
      });
      // разряд: прыжки по ближайшим целям с затуханием урона
      if (t.chainCount && t.chainRadius) {
        const hitIds = new Set([target.id]);
        let from = target;
        let jumpDmg = dmg;
        for (let j = 0; j < t.chainCount; j++) {
          const fp = this.monsterPx(from);
          const rPx = t.chainRadius * TILE;
          let next: Monster | null = null;
          let bestD = Infinity;
          for (const m of this.monsters) {
            if (hitIds.has(m.id) || m.hp <= 0) continue;
            const p = this.monsterPx(m);
            const dx = p.x - fp.x, dy = p.y - fp.y;
            const d = dx * dx + dy * dy;
            if (d <= rPx * rPx && d < bestD) { bestD = d; next = m; }
          }
          if (!next) break;
          jumpDmg *= t.chainFalloff ?? 1;
          this.hit(next, jumpDmg, t.id);
          hitIds.add(next.id);
          const np = this.monsterPx(next);
          this.attackEvents.push({
            t: this.time, fromCell: u.cell, fromX: fp.x, fromY: fp.y,
            x: np.x, y: np.y, color: t.color
          });
          from = next;
        }
      }
      u.cooldown += this.effPeriod(u);
    }

    // смерти
    const alive: Monster[] = [];
    for (const m of this.monsters) {
      if (m.hp <= 0) this.reward(m);
      else alive.push(m);
    }
    this.monsters = alive;

    // следующая волна: зачистка → драфт (каждые draft.every волн) или пауза-intermission;
    // таймаут → волны накладываются
    if (this.phase === 'combat') {
      const waveCleared = this.spawnQueue.length === 0 && this.monsters.length === 0;
      const waveTimedOut = this.time - this.waveStartedAt >= this.cfg.waveInterval;
      if (waveCleared) {
        if (this.wave >= this.lastDraftAtWave + this.cfg.draft.every) {
          this.lastDraftAtWave = this.wave;
          this.draftPending = this.generateDraft();
        } else {
          this.phase = 'intermission';
          this.intermissionEndsAt = this.time + this.cfg.intermissionSec;
        }
      } else if (waveTimedOut) {
        this.startNextWave();
      }
    }

    // подрезка событий рендера
    if (this.attackEvents.length > 200) {
      this.attackEvents = this.attackEvents.filter(e => this.time - e.t < 0.2);
    }
    if (this.blastEvents.length > 20) {
      this.blastEvents = this.blastEvents.filter(e => this.time - e.t < 1);
    }
  }

  // ---------- геометрия для рендера и AoE ----------

  monsterPx(m: Monster): { x: number; y: number } {
    const p = this.track.pos(m.progress);
    return { x: (p.x + 0.5) * TILE, y: (p.y + 0.5) * TILE };
  }

  cellPx(cell: number): { x: number; y: number } {
    const { cols } = this.cfg.grid;
    const c = cell % cols, r = Math.floor(cell / cols);
    const g = this.gridOriginPx();
    return { x: g.x + (c + 0.5) * TILE, y: g.y + (r + 0.5) * TILE };
  }

  trackTilePx(tile: number): { x: number; y: number } {
    const t = this.track.tiles[tile];
    return { x: (t.c + 0.5) * TILE, y: (t.r + 0.5) * TILE };
  }

  /** Индекс тайла трека в точке (px) или null, если точка вне трека. */
  trackTileAt(x: number, y: number): number | null {
    const c = Math.floor(x / TILE), r = Math.floor(y / TILE);
    for (let i = 0; i < this.track.length; i++) {
      const t = this.track.tiles[i];
      if (t.c === c && t.r === r) return i;
    }
    return null;
  }

  gridOriginPx(): { x: number; y: number } {
    const w = this.cfg.track.cols * TILE, h = this.cfg.track.rows * TILE;
    return {
      x: (w - this.cfg.grid.cols * TILE) / 2,
      y: (h - this.cfg.grid.rows * TILE) / 2
    };
  }

  get worldSize(): { w: number; h: number } {
    return { w: this.cfg.track.cols * TILE, h: this.cfg.track.rows * TILE };
  }

  // ---------- внутреннее ----------

  /** Эффективный период: ранг (×1.6 скорости за ранг) + Перегрев для атакующих юнитов. */
  private effPeriod(u: Unit): number {
    const t = this.unitType(u.typeId);
    let period = t.period / Math.pow(this.cfg.rankAtkSpeedMult, u.rank - 1);
    if (t.targeting !== 'none' && this.time < this.overdriveUntil) {
      period /= this.boostCfg('overdrive').atkSpeedMult ?? 1;
    }
    return period;
  }

  /** Множитель урона/эффекта: in-match уровень типа + драфт + мета-уровень башни. */
  private effMult(u: Unit): number {
    const level = this.typeLevels[u.typeId] ?? 1;
    return (1 + this.cfg.typeUpgrade.multPerLevel * (level - 1))
      * (1 + (this.typeDamageBonus[u.typeId] ?? 0))
      * (1 + towerDamageBonus(this.cfg, this.meta, u.typeId));
  }

  private effDamage(u: Unit, t: UnitTypeCfg): number {
    return t.damage * this.effMult(u);
  }

  private acquire(mode: 'first' | 'maxhp'): Monster | null {
    let best: Monster | null = null;
    for (const m of this.monsters) {
      if (m.hp <= 0) continue; // умер в этом тике
      if (!best || (mode === 'first' ? m.travelled > best.travelled : m.maxHp > best.maxHp)) best = m;
    }
    return best;
  }

  private hit(m: Monster, dmg: number, typeId: string): void {
    if (m.hp <= 0) return; // уже мёртв (умер в этом же тике) — не бить и не считать
    const applied = Math.min(m.hp, dmg);
    if (dmg > m.hp) {
      this.stats.overkillByType[typeId] = (this.stats.overkillByType[typeId] ?? 0) + (dmg - m.hp);
    }
    m.hp -= dmg;
    this.stats.damageByType[typeId] = (this.stats.damageByType[typeId] ?? 0) + applied;
    // корзина DPS-окна
    let arr = this.dpsBuckets.get(typeId);
    if (!arr) { arr = new Array(10).fill(0); this.dpsBuckets.set(typeId, arr); }
    arr[Math.floor(this.time) % 10] += applied;
  }

  private reward(m: Monster): void {
    this.addMana(m.type.reward * this.cfg.manaPerKillMult * (1 + this.manaKillBonus));
    this.stats.kills++;
    this.waveAcc.kills++;
  }

  /**
   * Гладкий рост HP. Раньше был множитель-ступенька каждые 10 волн (×1.5),
   * из-за которого на волнах 30/40 сложность прыгала в полтора раза за один шаг —
   * игрок упирался в стену. Теперь та же суммарная кривая, но непрерывная.
   */
  private waveHpMult(wave: number): number {
    const { linear, growth } = this.cfg.waveHp;
    return (1 + linear * wave) * Math.pow(growth, wave);
  }

  private startNextWave(): void {
    // снимок завершённой волны (этап 5)
    if (this.wave > 0) {
      const ranks: number[] = new Array(this.cfg.maxRank).fill(0);
      for (const u of this.units) ranks[u.rank - 1]++;
      const snap: WaveStats = { wave: this.wave, ...this.waveAcc, ranks };
      this.stats.waves.push(snap);
      this.waveAcc = { manaEarned: 0, manaSpentSummon: 0, manaSpentUpgrade: 0, manaFromGen: 0, merges: 0, kills: 0 };
    }
    this.wave++;
    this.stats.wavesReached = this.wave;
    this.waveStartedAt = this.time;
    const hpMult = this.waveHpMult(this.wave);
    const def = this.waves.defined.find(w => w.wave === this.wave);
    const groups: WaveGroup[] = def ? def.groups : this.proceduralGroups(this.wave);
    for (const g of groups) {
      const type = this.monsterTypeById.get(g.type);
      if (!type) continue;
      for (let i = 0; i < g.count; i++) {
        this.spawnQueue.push({ at: this.time + 0.5 + i * g.interval, type, hpMult });
      }
    }
    this.spawnQueue.sort((a, b) => a.at - b.at);
  }

  private proceduralGroups(wave: number): WaveGroup[] {
    const p = this.waves.procedural;
    const groups: WaveGroup[] = [];
    if (wave % p.bossEvery === 0) {
      groups.push({ type: 'boss', count: 1, interval: 1 });
      groups.push({ ...p.bossEscort });
      return groups;
    }
    let budget = p.hpBudgetBase * (1 + this.cfg.waveHp.linear * wave);
    const ids = Object.keys(p.weights);
    const totalW = ids.reduce((s, id) => s + p.weights[id], 0);
    // 2–3 группы на волну
    const nGroups = 2 + this.rng.int(2);
    for (let g = 0; g < nGroups && budget > 0; g++) {
      let roll = this.rng.next() * totalW;
      let id = ids[0];
      for (const cand of ids) {
        roll -= p.weights[cand];
        if (roll <= 0) { id = cand; break; }
      }
      const mt = this.monsterTypeById.get(id);
      if (!mt) continue;
      const share = g === nGroups - 1 ? budget : budget * (0.3 + this.rng.next() * 0.4);
      const count = Math.max(1, Math.round(share / mt.hp));
      groups.push({ type: id, count, interval: p.spawnInterval[id] ?? 0.8 });
      budget -= count * mt.hp;
    }
    return groups;
  }
}
