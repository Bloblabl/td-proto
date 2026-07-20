import Phaser from 'phaser';
import { Sim } from './core/sim';
import { randomSeed } from './core/rng';
import { GameScene } from './render/scene';
import { Controls } from './ui/controls';
import { Hud } from './ui/hud';
import type { BalanceCfg, WavesCfg } from './core/types';

const SIM_DT = 0.05; // фиксированный тик 50 мс — детерминизм по сиду
const MAX_STEPS_PER_FRAME = 20;

async function loadJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

/** Экран выбора колоды 5 из 7; резолвится списком id. */
function pickDeck(balance: BalanceCfg): Promise<string[]> {
  return new Promise(resolve => {
    const overlay = document.getElementById('deckOverlay')!;
    const box = document.getElementById('deckTypes')!;
    const startBtn = document.getElementById('deckStartBtn') as HTMLButtonElement;
    const picked = new Set<string>();
    const refresh = (): void => {
      startBtn.textContent = picked.size === balance.deckSize
        ? 'Старт' : `Выбрано ${picked.size} / ${balance.deckSize}`;
      startBtn.disabled = picked.size !== balance.deckSize;
    };
    for (const t of balance.unitTypes) {
      const b = document.createElement('button');
      b.textContent = t.name;
      b.style.borderColor = t.color;
      b.onclick = () => {
        if (picked.has(t.id)) picked.delete(t.id);
        else if (picked.size < balance.deckSize) picked.add(t.id);
        b.classList.toggle('picked', picked.has(t.id));
        refresh();
      };
      box.appendChild(b);
    }
    refresh();
    overlay.classList.add('open');
    startBtn.onclick = () => {
      overlay.classList.remove('open');
      resolve([...picked]);
    };
  });
}

/** Сид «Испытания дня»: одинаков у всех игроков в течение суток (UTC). */
function dailySeed(): number {
  return Number(new Date().toISOString().slice(0, 10).replace(/-/g, '')) >>> 0;
}

async function boot(): Promise<void> {
  const url = new URL(location.href);
  const mode = url.searchParams.get('mode') ?? 'arcade'; // arcade | daily | boss

  const [balance, waves] = await Promise.all([
    loadJson<BalanceCfg>('./config/balance.json'),
    loadJson<WavesCfg>(mode === 'boss' ? './config/waves_boss.json' : './config/waves.json')
  ]);

  const seedParam = url.searchParams.get('seed');
  const seed = mode === 'daily' ? dailySeed() : seedParam ? Number(seedParam) >>> 0 : randomSeed();

  // колода: из URL (?deck=a,b,c,d,e) или через экран выбора перед забегом;
  // в «Испытании дня» колода фиксированная — сравнение результатов честное
  const validIds = new Set(balance.unitTypes.map(t => t.id));
  let deckIds = url.searchParams.get('deck')?.split(',').filter(id => validIds.has(id));
  if (mode === 'daily') {
    deckIds = balance.unitTypes.slice(0, balance.deckSize).map(t => t.id);
  } else if (!deckIds || deckIds.length !== balance.deckSize) {
    deckIds = await pickDeck(balance);
    url.searchParams.set('deck', deckIds.join(','));
    history.replaceState(null, '', url.toString()); // рестарты сохраняют колоду и сид
  }

  const sim = new Sim(balance, waves, seed, deckIds, mode);
  const controls = new Controls();
  const hud = new Hud(sim, controls);
  const scene = new GameScene(sim, controls);
  // debug-доступ из консоли (§10 ТЗ): td.sim, td.controls
  Object.assign(window as object, { td: { sim, controls } });

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    backgroundColor: '#1b1d22',
    width: sim.worldSize.w,
    height: sim.worldSize.h,
    scene,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH
    }
  });

  // симуляция отделена от рендера: свой fixed-timestep цикл
  let acc = 0;
  let last = performance.now();
  let fpsEma = 60;
  const loop = (now: number): void => {
    const frame = Math.min((now - last) / 1000, 0.25);
    last = now;
    if (frame > 0) fpsEma += (1 / frame - fpsEma) * 0.05; // сглаженный FPS (этап 5)
    hud.fps = fpsEma;
    if (!hud.paused && !sim.gameOver) {
      acc += frame * hud.speed;
      let steps = 0;
      while (acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
        sim.tick(SIM_DT);
        acc -= SIM_DT;
        steps++;
      }
    }
    hud.update();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

void boot().catch(err => {
  document.body.innerHTML = `<pre style="color:#f66;padding:16px">Ошибка загрузки: ${String(err)}</pre>`;
});
