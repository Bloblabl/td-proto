export interface UnitTypeCfg {
  id: string;
  name: string;
  color: string;
  damage: number;
  /** Период атаки/дохода на ранге 1, сек */
  period: number;
  targeting: 'first' | 'maxhp' | 'none';
  aoeRadius?: number; // тайлы
  slowPct?: number;   // 0..1
  slowDur?: number;   // сек
  manaAmount?: number; // для генератора
  dotDps?: number;    // яд: урон в секунду
  dotDur?: number;    // яд: длительность, сек
  chainCount?: number;   // разряд: число прыжков после первой цели
  chainRadius?: number;  // разряд: радиус прыжка, тайлы
  chainFalloff?: number; // разряд: множитель урона за прыжок
}

export interface MonsterTypeCfg {
  id: string;
  name: string;
  hp: number;
  speed: number;  // тайлов/сек
  reward: number; // маны за убийство
  radius: number; // px, визуал + AoE-попадание
  color: string;
  slowCap?: number; // макс. суммарное замедление (босс 0.5)
}

export type ObstacleKind = 'barricade' | 'spikes' | 'slowzone';

export interface ObstaclesCfg {
  barricade: { hp: number; monsterDps: number; maxActive: number };
  spikes: { damage: number; period: number; duration: number; maxActive: number };
  slowzone: { slowPct: number; bossSlowPct: number; tiles: number; duration: number; maxActive: number };
  startInventory: Record<ObstacleKind, number>;
}

export type BoostId = 'meteor' | 'overdrive' | 'manasurge';

export interface BoostCfg {
  id: BoostId;
  name: string;
  cooldown: number;      // сек
  damage?: number;       // метеор
  radiusTiles?: number;  // метеор
  atkSpeedMult?: number; // перегрев: множитель скорости атаки (2.0 = +100%)
  duration?: number;     // перегрев, сек
  mana?: number;         // прилив маны
}

export type DraftPoolEntry =
  | { kind: 'typeDamage' }                       // раскрывается в карточку на каждый тип колоды
  | { kind: 'selector'; n: number }
  | { kind: 'obstacle'; ob: ObstacleKind; n: number }
  | { kind: 'boostCooldown'; pct: number }
  | { kind: 'manaKill'; pct: number }
  | { kind: 'rank2Summon'; n: number };

export interface DraftCfg {
  every: number;         // драфт после волн N, 2N, 3N…
  choices: number;       // карточек на выбор
  typeDamagePct: number; // бонус карточки typeDamage
  pool: DraftPoolEntry[];
}

/** Runtime-карточка драфта (пул раскрыт по колоде). */
export interface DraftCard {
  title: string;
  entry: DraftPoolEntry;
  typeId?: string; // для typeDamage
}

export interface BalanceCfg {
  grid: { cols: number; rows: number };
  track: { cols: number; rows: number };
  lives: number;
  startMana: number;
  summon: { baseCost: number; costStep: number };
  rankAtkSpeedMult: number;
  maxRank: number;
  typeUpgrade: { costs: number[]; multPerLevel: number };
  lapsDamage: boolean;
  waveInterval: number;
  intermissionSec: number;
  earlyWaveBonus: number;
  manaPerKillMult: number;
  waveHp: { linear: number; stepMult: number; stepEvery: number };
  boostStartCharge: number; // 0..1, доля готовности кулдаунов на старте
  selectorStart: number;
  deckSize: number;
  draft: DraftCfg;
  obstacles: ObstaclesCfg;
  boosts: BoostCfg[];
  unitTypes: UnitTypeCfg[];
  monsterTypes: MonsterTypeCfg[];
}

export interface WaveGroup {
  type: string;
  count: number;
  interval: number;
}

export interface WavesCfg {
  defined: { wave: number; groups: WaveGroup[] }[];
  procedural: {
    hpBudgetBase: number;
    weights: Record<string, number>;
    spawnInterval: Record<string, number>;
    bossEvery: number;
    bossEscort: WaveGroup;
  };
}

export interface Monster {
  id: number;
  type: MonsterTypeCfg;
  hp: number;
  maxHp: number;
  /** Позиция на треке в тайлах, [0, trackLen) */
  progress: number;
  /** Пройдено суммарно (для таргетинга first) */
  travelled: number;
  slowPct: number;
  slowUntil: number;
  dotDps: number;
  dotUntil: number;
  dotSrc: string; // id типа юнита для статистики
}

export interface Unit {
  id: number;
  typeId: string;
  rank: number;
  cell: number; // индекс клетки поля
  cooldown: number;
}

export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  tile: number;        // стартовый тайл трека
  hp?: number;         // баррикада
  maxHp?: number;
  expiresAt?: number;  // шипы, слоу-зона
  nextTickAt?: number; // шипы
}

export interface BoostState {
  id: BoostId;
  readyAt: number; // время симуляции, когда буст снова доступен
}

export interface AttackEvent {
  t: number;      // время симуляции
  fromCell: number;
  x: number;      // цель, px
  y: number;
  color: string;
  aoeRadiusPx?: number;
  /** Начало луча в px (прыжки разряда); если задано — важнее fromCell */
  fromX?: number;
  fromY?: number;
}

/** Взрыв/вспышка без исходной клетки (метеор). */
export interface BlastEvent {
  t: number;
  x: number;
  y: number;
  radiusPx: number;
}

/** Срез статистики по одной завершённой волне (этап 5). */
export interface WaveStats {
  wave: number;
  manaEarned: number;
  manaSpentSummon: number;
  manaSpentUpgrade: number;
  manaFromGen: number;
  merges: number;
  kills: number;
  /** Распределение рангов юнитов на конец волны: ranks[0] = число юнитов ранга 1 */
  ranks: number[];
}

export interface RunStats {
  seed: number;
  mode: string;
  wavesReached: number;
  timeSec: number;
  kills: number;
  merges: number;
  summons: number;
  manaEarned: number;
  manaSpentSummon: number;
  manaSpentUpgrade: number;
  /** Мана, произведённая Генераторами за забег */
  manaFromGen: number;
  /** Урон по источникам: id типа юнита, 'spikes', 'meteor' */
  damageByType: Record<string, number>;
  /** Перерасход урона (добивание сверх HP) по источникам */
  overkillByType: Record<string, number>;
  /** Статистика по завершённым волнам */
  waves: WaveStats[];
  /** Использования бустов: id → [{wave, time}] */
  boostsUsed: Record<string, { wave: number; time: number }[]>;
  /** «Купленное время» заграждений, сек задержки монстров: barricade / slowzone */
  timeBought: Record<string, number>;
  obstaclesPlaced: Record<string, number>;
  selectorsUsed: number;
  /** Выбранные карточки драфта: волна → заголовок */
  draftPicks: { wave: number; title: string }[];
}
