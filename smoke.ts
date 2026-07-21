import { readFileSync } from 'node:fs';
import { Sim } from './src/core/sim';
import type { BalanceCfg, WavesCfg } from './src/core/types';

const balance = JSON.parse(readFileSync('public/config/balance.json', 'utf8')) as BalanceCfg;
const waves = JSON.parse(readFileSync('public/config/waves.json', 'utf8')) as WavesCfg;
const wavesBoss = JSON.parse(readFileSync('public/config/waves_boss.json', 'utf8')) as WavesCfg;

// простой бот: призывает, мерджит, ставит заграждения и жмёт бусты по готовности
function run(seed: number, deckIds?: string[], wavesCfg: WavesCfg = waves): {
  wave: number; time: number; kills: number; merges: number;
  bought: string; boosts: number; selectors: number; drafts: string; dmg?: string;
  waveStats: number; overkill: number; genShare: string;
} {
  const sim = new Sim(balance, wavesCfg, seed, deckIds);
  let guard = 0;
  while (!sim.gameOver && guard++ < 120000) { // до 100 мин симуляции
    sim.tick(0.05);
    if (sim.draftPending) sim.pickDraft(sim.rng.int(sim.draftPending.length));
    if (sim.rng.next() < 0.1) sim.summon();
    // поиск пары для мерджа (иногда — через Селектор)
    outer: for (const a of sim.units) {
      for (const b of sim.units) {
        if (a.id !== b.id && a.typeId === b.typeId && a.rank === b.rank) {
          if (sim.selectors > 0 && sim.rng.next() < 0.5) sim.armSelector('gunner');
          sim.merge(a.id, b.id);
          break outer;
        }
      }
    }
    const t = sim.deck[sim.rng.int(sim.deck.length)];
    if (sim.rng.next() < 0.02) sim.upgradeType(t.id);
    // заграждения на случайный тайл, бусты по готовности
    if (sim.rng.next() < 0.01) {
      const kinds = ['barricade', 'spikes', 'slowzone'] as const;
      sim.placeObstacle(sim.rng.pick(kinds), sim.rng.int(sim.track.length));
    }
    if (sim.rng.next() < 0.01) {
      const m = sim.monsters[0];
      if (m) { const p = sim.monsterPx(m); sim.useBoost('meteor', p.x, p.y); }
      sim.useBoost('overdrive');
      sim.useBoost('manasurge');
    }
  }
  const tb = sim.stats.timeBought;
  return {
    wave: sim.stats.wavesReached, time: Math.round(sim.stats.timeSec),
    kills: sim.stats.kills, merges: sim.stats.merges,
    bought: `${tb.barricade.toFixed(1)}с/${tb.slowzone.toFixed(1)}с`,
    boosts: Object.values(sim.stats.boostsUsed).reduce((s, u) => s + u.length, 0),
    selectors: sim.stats.selectorsUsed,
    drafts: sim.stats.draftPicks.map(p => `в${p.wave}:${p.title}`).join(' | ') || '—',
    dmg: Object.entries(sim.stats.damageByType)
      .map(([k, v]) => `${k}:${Math.round(v)}`).join(' '),
    waveStats: sim.stats.waves.length,
    overkill: Math.round(Object.values(sim.stats.overkillByType).reduce((a, b) => a + b, 0)),
    genShare: sim.stats.manaEarned > 0
      ? `${Math.round(100 * sim.stats.manaFromGen / sim.stats.manaEarned)}%` : '0%'
  };
}

const r1 = run(12345);
const r2 = run(12345);
const r3 = run(99999);
const altDeck = ['gunner', 'frost', 'gen', 'poison', 'arc'];
const r4 = run(12345, altDeck);
const r5 = run(20260720, undefined, wavesBoss);
console.log('seed 12345 #1:', r1);
console.log('seed 12345 #2:', r2);
console.log('seed 99999   :', r3);
console.log('seed 12345, колода Яд+Разряд:', r4);
console.log('boss rush (сид-дата):', r5);

// проверки: ненулевой код выхода при провале — smoke работает как гейт в CI
let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${name}: ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failed++;
}

check('детерминизм по сиду', JSON.stringify(r1) === JSON.stringify(r2));
check('разные сиды дают разные забеги', JSON.stringify(r1) !== JSON.stringify(r3));
check('новые типы наносят урон',
  Boolean(r4.dmg?.includes('poison') && r4.dmg?.includes('arc')));
check('телеметрия волн', r1.waveStats > 0 && r1.overkill > 0 && r1.genShare !== '0%');
check('заграждения покупают время', parseFloat(r1.bought) > 0);
check('boss rush играется', r5.wave > 1);
check('забеги содержательной длины', r1.wave >= 10 && r1.merges > 0);

if (failed > 0) {
  console.error(`\n${failed} проверок провалено`);
  process.exit(1);
}
console.log('\nвсе проверки пройдены');
