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
        if (sim.canMerge(a, b)) {
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

// --- правило мерджа: строгое, тип И ранг ---
{
  const sim = new Sim(balance, waves, 1, ['gunner', 'volley', 'frost', 'gen', 'sniper']);
  sim.addMana(100000);
  while (sim.units.length < 4) sim.summon();
  const [u0, u1, u2, u3] = sim.units;
  for (const u of [u0, u1, u2, u3]) u.rank = 2;
  u0.typeId = 'gunner'; u1.typeId = 'volley';   // разные типы
  u2.typeId = 'frost'; u3.typeId = 'frost';     // одинаковые

  check('разные типы одного ранга НЕ сливаются', !sim.canMerge(u0, u1));
  check('одинаковые тип+ранг сливаются', sim.canMerge(u2, u3));
  const okSame = sim.merge(u2.id, u3.id);
  check('мердж тип+ранг выполняется', okSame && u3.rank === 3);

  const a = sim.units[0], b = sim.units[1];
  a.typeId = b.typeId = 'gunner'; a.rank = 2; b.rank = 4;
  check('разные ранги не сливаются', !sim.canMerge(a, b));
}

// --- элементные реакции (Волна 1): через реальный tick ---
{
  const s = new Sim(balance, waves, 1, ['gunner', 'frost', 'poison', 'arc', 'pyro']);
  (s as unknown as { spawnQueue: unknown[] }).spawnQueue = [];
  const tank = balance.monsterTypes.find(m => m.id === 'tank')!;
  let nid = 5000;
  const mob = (progress: number, hp = 5000) => ({
    id: nid++, type: tank, hp, maxHp: hp, progress, travelled: progress,
    slowPct: 0, slowUntil: 0, dotDps: 0, dotPct: 0, dotUntil: 0, dotSrc: '',
    dotElem: '' as const, wetUntil: 0, stunUntil: 0, freezeImmuneUntil: 0
  });

  // заморозка: мокрая цель + мороз → стан
  const f = mob(5); f.wetUntil = s.time + 3; s.monsters = [f];
  s.units = [{ id: 1, typeId: 'frost', rank: 1, cell: 0, cooldown: 0 }];
  s.tick(0.05);
  check('реакция Заморозка (Мокро+Мороз → стан)', f.stunUntil > s.time);

  // детонация: отравленная цель + горение → взрыв
  const d = mob(5); d.dotElem = 'poison'; d.dotDps = 40; d.dotUntil = s.time + 5; s.monsters = [d];
  s.units = [{ id: 2, typeId: 'pyro', rank: 1, cell: 0, cooldown: 0 }];
  const blasts = s.blastEvents.length;
  s.tick(0.05);
  check('реакция Детонация (Яд+Горение → взрыв)', s.blastEvents.length > blasts);

  // мокро НЕ разносится молнией (защита от лавины)
  const w0 = mob(5.4); w0.wetUntil = s.time + 3;
  const w1 = mob(5.2), w2 = mob(5.0);
  s.monsters = [w0, w1, w2];
  s.units = [{ id: 3, typeId: 'arc', rank: 1, cell: 0, cooldown: 0 }];
  s.tick(0.05);
  check('Мокро не разносится молнией (нет лавины)', w1.wetUntil <= s.time && w2.wetUntil <= s.time);

  // иммунитет к заморозке: повторная заморозка в окно иммунитета не проходит
  const fz = mob(5); fz.wetUntil = s.time + 3; s.monsters = [fz];
  s.units = [{ id: 4, typeId: 'frost', rank: 1, cell: 0, cooldown: 0 }];
  s.tick(0.05);
  const stun1 = fz.stunUntil, imm = fz.freezeImmuneUntil;
  fz.wetUntil = s.time + 3; // снова мочим — но иммунитет активен
  s.units = [{ id: 5, typeId: 'frost', rank: 1, cell: 0, cooldown: 0 }];
  s.tick(0.05);
  check('Заморозка ставит иммунитет (защита от пермафриза)',
    stun1 > s.time && imm > stun1 && fz.stunUntil <= stun1 + 0.1);
}

// --- умный призыв: страхует от заполнения поля без пар ---
{
  const sim = new Sim(balance, waves, 5, ['gunner', 'volley', 'frost', 'gen', 'sniper']);
  sim.addMana(1000000);
  // забиваем поле призывами и сразу после каждого проверяем, что ход не потерян
  let everStuck = false;
  for (let i = 0; i < 200; i++) {
    if (!sim.summon()) {
      // поле полно — умный призыв обязан был оставить пару
      if (!sim.hasMergeMove()) { everStuck = true; break; }
      // освобождаем клетку мерджем и продолжаем
      for (const x of sim.units) {
        const y = sim.units.find(u => sim.canMerge(x, u));
        if (y) { sim.merge(x.id, y.id); break; }
      }
    }
  }
  check('умный призыв не даёт запереть поле', !everStuck);
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
