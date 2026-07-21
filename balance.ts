/**
 * Харнесс массовых балансных симуляций (headless, без Phaser).
 *
 * Запуск: npm run balance
 *
 * Отвечает на вопросы §1.1 ТЗ числами:
 *  1. «Мерджить или копить» — реальное решение или фикция?
 *  2. Не доминирует ли Генератор в экономике?
 *  3. Какие типы юнитов тянут забег, а какие мертвы?
 *  4. Куда уходит overkill?
 *
 * ВАЖНО: выводы описывают игру ботов, а не людей. Бот не планирует, не
 * держит Метеор под босса и не выбирает драфт осмысленно. Симуляции ловят
 * грубые перекосы; тонкий баланс — только плейтест.
 */
import { readFileSync } from 'node:fs';
import { Sim } from './src/core/sim';
import { Rng } from './src/core/rng';
import { critDamageFactor, emptyMeta } from './src/core/meta';
import type { BalanceCfg, MetaState, WavesCfg } from './src/core/types';

const balance = JSON.parse(readFileSync('public/config/balance.json', 'utf8')) as BalanceCfg;
const waves = JSON.parse(readFileSync('public/config/waves.json', 'utf8')) as WavesCfg;

const DT = 0.05;
const MAX_TICKS = 240000; // 200 минут симуляции — потолок, до него доживают единицы

interface Policy {
  name: string;
  /**
   * Порог заполненности поля, при котором бот начинает мерджить:
   * 0 — мерджит сразу, 1 — только когда клетки кончились, Infinity — никогда.
   */
  mergeAt: number;
  /** Доля маны, которую бот готов тратить на апгрейды типов (остальное — призыв) */
  upgradeShare: number;
}

interface RunResult {
  wave: number;
  timeSec: number;
  merges: number;
  summons: number;
  damageByType: Record<string, number>;
  overkillByType: Record<string, number>;
  manaEarned: number;
  manaFromGen: number;
}

/**
 * Бот с собственным RNG: решения бота не сдвигают RNG-поток симуляции,
 * поэтому политики сравнимы между собой на одном сиде.
 */
function run(
  seed: number, deck: string[], policy: Policy,
  cfg: BalanceCfg = balance, meta?: MetaState
): RunResult {
  const sim = new Sim(cfg, waves, seed, deck, 'arcade', meta);
  const bot = new Rng(seed ^ 0x9e3779b9);
  const cells = sim.gridCells;

  for (let i = 0; i < MAX_TICKS && !sim.gameOver; i++) {
    sim.tick(DT);

    if (sim.draftPending) {
      sim.pickDraft(bot.int(sim.draftPending.length));
      continue;
    }

    // апгрейд типа: тратим на него заданную долю маны, начиная с самого дешёвого
    if (bot.next() < policy.upgradeShare) {
      let best: string | null = null;
      let bestCost = Infinity;
      for (const t of sim.deck) {
        const c = sim.upgradeTypeCost(t.id);
        if (c !== null && c <= sim.mana && c < bestCost) { best = t.id; bestCost = c; }
      }
      if (best) sim.upgradeType(best);
    }

    // призыв: всегда, если хватает маны и есть место
    if (sim.units.length < cells) sim.summon();

    // мердж по политике
    if (sim.units.length / cells >= policy.mergeAt) {
      // мерджим самую низкоранговую пару: освобождает клетку, не ломая топ-юниты
      let a = null, b = null, lowest = Infinity;
      for (const x of sim.units) {
        for (const y of sim.units) {
          if (x.id !== y.id && x.typeId === y.typeId && x.rank === y.rank && x.rank < lowest) {
            lowest = x.rank; a = x; b = y;
          }
        }
      }
      if (a && b) sim.merge(a.id, b.id);
    }

    // заграждения: ставим по мере поступления, ближе к «воротам» базы
    for (const kind of ['barricade', 'spikes', 'slowzone'] as const) {
      if (sim.canPlaceObstacle(kind)) {
        sim.placeObstacle(kind, Math.floor(sim.track.length * 0.75) + bot.int(3));
      }
    }

    // бусты: по готовности; Метеор — по самому жирному монстру
    if (sim.boostReadyIn('meteor') === 0 && sim.monsters.length > 0) {
      let fat = sim.monsters[0];
      for (const m of sim.monsters) if (m.hp > fat.hp) fat = m;
      const p = sim.monsterPx(fat);
      sim.useBoost('meteor', p.x, p.y);
    }
    if (sim.boostReadyIn('overdrive') === 0) sim.useBoost('overdrive');
    if (sim.boostReadyIn('manasurge') === 0) sim.useBoost('manasurge');
  }

  return {
    wave: sim.stats.wavesReached,
    timeSec: sim.stats.timeSec,
    merges: sim.stats.merges,
    summons: sim.stats.summons,
    damageByType: sim.stats.damageByType,
    overkillByType: sim.stats.overkillByType,
    manaEarned: sim.stats.manaEarned,
    manaFromGen: sim.stats.manaFromGen
  };
}

// ---------- агрегация ----------

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

function mergeSums(target: Record<string, number>, src: Record<string, number>): void {
  for (const [k, v] of Object.entries(src)) target[k] = (target[k] ?? 0) + v;
}

interface Agg {
  runs: number;
  waves: number[];
  damage: Record<string, number>;
  overkill: Record<string, number>;
  manaEarned: number;
  manaFromGen: number;
  merges: number;
}

function aggregate(
  seeds: number[], deck: string[], policy: Policy,
  cfg: BalanceCfg = balance, meta?: MetaState
): Agg {
  const agg: Agg = {
    runs: 0, waves: [], damage: {}, overkill: {}, manaEarned: 0, manaFromGen: 0, merges: 0
  };
  for (const s of seeds) {
    const r = run(s, deck, policy, cfg, meta);
    agg.runs++;
    agg.waves.push(r.wave);
    mergeSums(agg.damage, r.damageByType);
    mergeSums(agg.overkill, r.overkillByType);
    agg.manaEarned += r.manaEarned;
    agg.manaFromGen += r.manaFromGen;
    agg.merges += r.merges;
  }
  return agg;
}

function name(id: string): string {
  return balance.unitTypes.find(t => t.id === id)?.name ?? id;
}

// ---------- эксперименты ----------

const N = Number(process.argv[2] ?? 40);
const seeds = Array.from({ length: N }, (_, i) => (i * 7919 + 12345) >>> 0);
const DEFAULT_DECK = balance.unitTypes.slice(0, balance.deckSize).map(t => t.id);
const t0 = Date.now();

console.log(`Балансные симуляции: ${N} сидов на конфигурацию\n`);

// --- 1. Мерджить или копить ---
console.log('=== 1. «Мерджить или копить»: сравнение политик ===');
console.log('Колода по умолчанию:', DEFAULT_DECK.map(name).join(', '));
const policies: Policy[] = [
  { name: 'always (мерджить сразу)', mergeAt: 0, upgradeShare: 0.02 },
  { name: 'balanced (поле на 80%)', mergeAt: 0.8, upgradeShare: 0.02 },
  { name: 'boardFull (копить до конца)', mergeAt: 1, upgradeShare: 0.02 },
  { name: 'never (не мерджить)', mergeAt: Infinity, upgradeShare: 0.02 }
];
const policyResults: { p: Policy; a: Agg }[] = [];
for (const p of policies) {
  const a = aggregate(seeds, DEFAULT_DECK, p);
  policyResults.push({ p, a });
  console.log(
    `  ${p.name.padEnd(28)} медиана волны ${String(median(a.waves)).padStart(5)}` +
    ` · p25 ${String(pct(a.waves, 0.25)).padStart(3)} · p75 ${String(pct(a.waves, 0.75)).padStart(3)}` +
    ` · мерджей/забег ${(a.merges / a.runs).toFixed(1)}`
  );
}
const best = policyResults.reduce((x, y) => median(y.a.waves) > median(x.a.waves) ? y : x);
const worst = policyResults.reduce((x, y) => median(y.a.waves) < median(x.a.waves) ? y : x);
const spread = median(best.a.waves) / Math.max(1, median(worst.a.waves));
console.log(`  → разрыв лучшей и худшей политики: ×${spread.toFixed(2)}` +
  ` (${best.p.name} vs ${worst.p.name})`);

// --- 2. Генератор: доля экономики и вклад в результат ---
console.log('\n=== 2. Генератор: доминирует ли экономика? ===');
const withGen = DEFAULT_DECK;
const noGen = balance.unitTypes.filter(t => t.id !== 'gen').slice(0, balance.deckSize).map(t => t.id);
const pol: Policy = { name: 'balanced', mergeAt: 0.8, upgradeShare: 0.02 };
const aGen = aggregate(seeds, withGen, pol);
const aNoGen = aggregate(seeds, noGen, pol);
console.log(`  с Генератором  (${withGen.map(name).join(', ')})`);
console.log(`    медиана волны ${median(aGen.waves)} · доля маны от Генератора ` +
  `${Math.round(100 * aGen.manaFromGen / aGen.manaEarned)}%`);
console.log(`  без Генератора (${noGen.map(name).join(', ')})`);
console.log(`    медиана волны ${median(aNoGen.waves)}`);
console.log(`  → преимущество Генератора: ×${(median(aGen.waves) / Math.max(1, median(aNoGen.waves))).toFixed(2)}`);

// --- 3. Вклад типов в урон ---
console.log('\n=== 3. Вклад типов в урон (все 7 типов, по 5 в колоде) ===');
const damageShare: Record<string, { dmg: number; runs: number }> = {};
const allTypes = balance.unitTypes.map(t => t.id);
// каждый тип участвует в нескольких колодах: скользящее окно по списку типов
for (let off = 0; off < allTypes.length; off++) {
  const deck = Array.from({ length: balance.deckSize }, (_, k) => allTypes[(off + k) % allTypes.length]);
  const a = aggregate(seeds.slice(0, Math.max(8, N / 4)), deck, pol);
  const total = Object.values(a.damage).reduce((x, y) => x + y, 0);
  for (const id of deck) {
    damageShare[id] ??= { dmg: 0, runs: 0 };
    damageShare[id].dmg += (a.damage[id] ?? 0) / Math.max(1, total);
    damageShare[id].runs++;
  }
}
const shares = Object.entries(damageShare)
  .map(([id, v]) => ({ id, share: v.dmg / v.runs }))
  .sort((a, b) => b.share - a.share);
for (const s of shares) {
  const bar = '█'.repeat(Math.round(s.share * 60));
  console.log(`  ${name(s.id).padEnd(10)} ${(s.share * 100).toFixed(1).padStart(5)}%  ${bar}`);
}

// --- 4. Overkill ---
console.log('\n=== 4. Overkill: доля урона в пустоту ===');
const aOver = aggregate(seeds, DEFAULT_DECK, pol);
const rows = Object.keys({ ...aOver.damage, ...aOver.overkill })
  .map(id => {
    const dmg = aOver.damage[id] ?? 0;
    const over = aOver.overkill[id] ?? 0;
    return { id, dmg, over, ratio: dmg > 0 ? over / (dmg + over) : 0 };
  })
  .filter(r => r.dmg + r.over > 0)
  .sort((a, b) => b.ratio - a.ratio);
for (const r of rows) {
  console.log(`  ${name(r.id).padEnd(10)} overkill ${(r.ratio * 100).toFixed(1).padStart(5)}%` +
    ` от нанесённого (${Math.round(r.over).toLocaleString('ru')} впустую)`);
}

// --- 5. Где оптимум порога мерджа ---
console.log('\n=== 5. Кривая порога мерджа: есть ли внутренний оптимум? ===');
console.log('  (если кривая монотонно растёт до 100% — «копить» решает игру простым правилом)');
const thresholds = [0, 0.2, 0.4, 0.6, 0.73, 0.87, 1];
const curve: { at: number; med: number }[] = [];
for (const at of thresholds) {
  const a = aggregate(seeds, DEFAULT_DECK, { name: `at${at}`, mergeAt: at, upgradeShare: 0.02 });
  const med = median(a.waves);
  curve.push({ at, med });
  const label = at === 1 ? 'только когда поле полно' : `поле на ${Math.round(at * 100)}%`;
  console.log(`  мерджить при ${label.padEnd(24)} медиана ${String(med).padStart(5)}` +
    `  ${'█'.repeat(Math.round(med))}`);
}
const peak = curve.reduce((x, y) => y.med > x.med ? y : x);
const low = curve.reduce((x, y) => y.med < x.med ? y : x);
const curveSpread = peak.med / Math.max(1, low.med);
console.log(`  → максимум на ${Math.round(peak.at * 100)}% (медиана ${peak.med}), ` +
  `минимум на ${Math.round(low.at * 100)}% (${low.med}), разброс ×${curveSpread.toFixed(2)}`);
// главное — не форма кривой, а её крутизна: если разброс мал, любой порог играбелен
console.log(`  → ${curveSpread < 1.12
  ? 'КРИВАЯ ПОЛОГАЯ: цена ошибки мала, порог мерджа — вопрос стиля, а не единственно верного правила'
  : 'КРИВАЯ КРУТАЯ: есть заметно доминирующий порог — решение вырождается в правило'}`);

// --- 6. Какой rankAtkSpeedMult делает мердж равновыгодным ---
console.log('\n=== 6. Чувствительность к rankAtkSpeedMult (сейчас ' +
  `${balance.rankAtkSpeedMult}, merge efficiency = ${(balance.rankAtkSpeedMult / 2).toFixed(2)}) ===`);
console.log('  сравнение «мерджить сразу» vs «копить до конца» при разных значениях:');
for (const mult of [1.6, 1.8, 2.0, 2.2]) {
  const cfg: BalanceCfg = { ...balance, rankAtkSpeedMult: mult };
  const early = median(aggregate(seeds, DEFAULT_DECK,
    { name: 'e', mergeAt: 0, upgradeShare: 0.02 }, cfg).waves);
  const late = median(aggregate(seeds, DEFAULT_DECK,
    { name: 'l', mergeAt: 1, upgradeShare: 0.02 }, cfg).waves);
  const gap = late / Math.max(1, early);
  const verdict = gap > 1.15 ? 'копить явно лучше'
    : gap < 0.87 ? 'мерджить явно лучше' : 'ПАРИТЕТ — решение зависит от ситуации';
  console.log(`  ×${mult.toFixed(1)} (eff ${(mult / 2).toFixed(2)}): сразу ${String(early).padStart(4)}` +
    ` · копить ${String(late).padStart(4)} · разрыв ×${gap.toFixed(2)} — ${verdict}`);
}

// --- 7. Мета-прогрессия: двигает ли крит стену сложности ---
console.log('\n=== 7. Мета-прокачка: как далеко уезжает стена ===');
function metaWithLevels(perTower: number): MetaState {
  const m = emptyMeta(balance);
  for (const t of balance.unitTypes) m.levels[t.id] = 1 + perTower;
  return m;
}
for (const lvl of [0, 3, 6, 10, 14, 19]) {
  const m = metaWithLevels(lvl);
  const a = aggregate(seeds, DEFAULT_DECK, pol, balance, m);
  const f = critDamageFactor(balance, m);
  console.log(
    `  все башни ур.${String(lvl + 1).padStart(2)} · крит ×${f.toFixed(2)} к урону` +
    ` → медиана волны ${String(median(a.waves)).padStart(5)} (p75 ${pct(a.waves, 0.75)})`
  );
}

// --- 8. Профиль сложности: плавная ли кривая ---
console.log('\n=== 8. Рост HP по волнам: нет ли обрывов ===');
const hp = (w: number): number => (1 + balance.waveHp.linear * w) * Math.pow(balance.waveHp.growth, w);
// скачки считаем с 10-й волны: на первых волнах HP мал, и относительный
// скачок там ничего не значит в абсолютных числах
let maxJump = 0, maxJumpAt = 0;
for (let w = 11; w <= 60; w++) {
  const jump = hp(w) / hp(w - 1);
  if (jump > maxJump) { maxJump = jump; maxJumpAt = w; }
}
const marks = [10, 20, 30, 40, 50, 60];
console.log('  HP-множитель: ' + marks.map(w => `в${w}=×${hp(w).toFixed(1)}`).join('  '));
console.log(`  → максимальный скачок за волну (после 10-й): ×${maxJump.toFixed(3)} (волна ${maxJumpAt})` +
  `${maxJump < 1.12 ? ' — кривая гладкая, стены нет' : ' — ОБРЫВ, игрок упрётся в стену'}`);

console.log(`\nготово за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
