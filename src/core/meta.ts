import type { BalanceCfg, MetaState, RunStats } from './types';

/**
 * Мета-прогрессия между забегами. Чистые функции без DOM и Phaser —
 * переносятся в C# один в один вместе с остальным core/.
 *
 * Идея (как в Random Dice): уровень любой башни поднимает ОБЩИЙ крит,
 * поэтому вложение в любую башню усиливает весь состав, а не только её.
 */

export function emptyMeta(cfg: BalanceCfg): MetaState {
  const levels: Record<string, number> = {};
  for (const t of cfg.unitTypes) levels[t.id] = 1;
  return { currency: 0, levels };
}

/** Подставляет отсутствующие типы и чинит битые значения из localStorage. */
export function normalizeMeta(cfg: BalanceCfg, raw: unknown): MetaState {
  const base = emptyMeta(cfg);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<MetaState>;
  if (typeof r.currency === 'number' && Number.isFinite(r.currency)) {
    base.currency = Math.max(0, Math.floor(r.currency));
  }
  if (r.levels && typeof r.levels === 'object') {
    for (const t of cfg.unitTypes) {
      const lv = (r.levels as Record<string, unknown>)[t.id];
      if (typeof lv === 'number' && Number.isFinite(lv)) {
        base.levels[t.id] = Math.min(cfg.meta.towerUpgrade.maxLevel, Math.max(1, Math.floor(lv)));
      }
    }
  }
  return base;
}

/** Суммарное число вложенных уровней (уровень 1 — стартовый, вклада не даёт). */
export function totalLevels(cfg: BalanceCfg, meta: MetaState): number {
  let n = 0;
  for (const t of cfg.unitTypes) n += (meta.levels[t.id] ?? 1) - 1;
  return n;
}

/** Общий крит: растёт от суммы уровней ВСЕХ башен. */
export function critStats(cfg: BalanceCfg, meta: MetaState): { chance: number; mult: number } {
  const n = totalLevels(cfg, meta);
  const c = cfg.meta.crit;
  return {
    chance: Math.min(c.maxChance, c.baseChance + c.chancePerLevel * n),
    mult: c.baseMult + c.multPerLevel * n
  };
}

/** Средний множитель урона от крита — для показа игроку и для симуляций. */
export function critDamageFactor(cfg: BalanceCfg, meta: MetaState): number {
  const { chance, mult } = critStats(cfg, meta);
  return 1 + chance * (mult - 1);
}

/** Бонус урона конкретного типа от его уровня. */
export function towerDamageBonus(cfg: BalanceCfg, meta: MetaState, typeId: string): number {
  const lv = (meta.levels[typeId] ?? 1) - 1;
  return cfg.meta.towerUpgrade.damagePerLevel * lv;
}

/** Цена следующего уровня башни; null — максимум. */
export function upgradeCost(cfg: BalanceCfg, meta: MetaState, typeId: string): number | null {
  const u = cfg.meta.towerUpgrade;
  const lv = meta.levels[typeId] ?? 1;
  if (lv >= u.maxLevel) return null;
  return Math.round(u.baseCost * Math.pow(u.costGrowth, lv - 1));
}

/** Купить уровень башни. Мутирует meta; возвращает false, если не хватило валюты. */
export function buyUpgrade(cfg: BalanceCfg, meta: MetaState, typeId: string): boolean {
  const cost = upgradeCost(cfg, meta, typeId);
  if (cost === null || meta.currency < cost) return false;
  meta.currency -= cost;
  meta.levels[typeId] = (meta.levels[typeId] ?? 1) + 1;
  return true;
}

/** Награда за забег. Босс-волны ценятся отдельно — стимул доходить до них. */
export function runReward(cfg: BalanceCfg, stats: RunStats, bossEvery: number): number {
  const c = cfg.meta.currency;
  const waves = stats.wavesReached;
  const bossWaves = bossEvery > 0 ? Math.floor(waves / bossEvery) : 0;
  return Math.round(waves * c.perWave + bossWaves * c.perBossWave + stats.kills * c.perKill);
}
