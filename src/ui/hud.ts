import { runReward } from '../core/meta';
import { Sim } from '../core/sim';
import { shapeSvg } from '../render/shapes';
import type { BoostId, MetaState, ObstacleKind } from '../core/types';
import type { Controls } from './controls';
import { saveMeta } from './storage';

function el<T extends HTMLElement>(id: string): T {
	const e = document.getElementById(id);
	if (!e) throw new Error(`#${id} not found`);
	return e as T;
}

const OBSTACLE_NAMES: Record<ObstacleKind, string> = {
	barricade: '🧱 Баррикада', spikes: '▲ Шипы', slowzone: '❄ Слоу'
};
const SOURCE_NAMES: Record<string, string> = { spikes: 'Шипы (заграждение)', meteor: 'Метеор (буст)' };

export class Hud {
	speed = 1;
	paused = false;
	fps = 60;
	private dpsShown = false;
	private overlayShown = false;
	private shownDraft: unknown = null;
	private upgButtons = new Map<string, HTMLButtonElement>();
	private obButtons = new Map<ObstacleKind, HTMLButtonElement>();
	private boostButtons = new Map<BoostId, HTMLButtonElement>();

	constructor(private sim: Sim, private controls: Controls, private meta: MetaState) {
		el('seedLbl').textContent = `сид ${sim.seed}`;
		el('modeLbl').textContent =
			sim.mode === 'daily' ? '📅 Испытание дня' : sim.mode === 'boss' ? '💀 Boss Rush' : '';
		el('critLbl').innerHTML =
			`⚡ <b>${Math.round(sim.critChance * 100)}%</b> ×${sim.critMult.toFixed(2)}`;

		el('summonBtn').onclick = () => sim.summon();
		el('nextWaveBtn').onclick = () => sim.callNextWave();
		el('helpBtn').onclick = () => {
			el('helpPanel').classList.toggle('open');
		};
		this.buildUpgradeRow();
		this.buildConsumables();

		const spd = (n: number, id: string) => {
			el(id).onclick = () => {
				this.speed = n;
				this.paused = false;
				for (const b of ['spd1', 'spd2', 'spd4']) el(b).classList.toggle('active', b === id);
				el('pauseBtn').textContent = '⏸';
			};
		};
		spd(1, 'spd1'); spd(2, 'spd2'); spd(4, 'spd4');
		const togglePause = () => {
			this.paused = !this.paused;
			const label = this.paused ? '▶' : '⏸';
			el('pauseBtn').textContent = label;
			el('pauseTop').textContent = label;
		};
		el('pauseBtn').onclick = togglePause;   // дублёр в дебаг-баре (админ)
		el('pauseTop').onclick = togglePause;   // основная пауза в шапке

		// выход в главное меню (сброс параметров URL); подтверждаем, если забег идёт
		el('menuBtn').onclick = () => {
			if (!sim.gameOver && !confirm('Выйти в меню? Текущий забег не сохранится.')) return;
			location.href = location.origin + location.pathname;
		};

		el('dbgMana').onclick = () => sim.addMana(1000);
		el('dbgCons').onclick = () => {
			sim.addObstacles('barricade', 1);
			sim.addObstacles('spikes', 2);
			sim.addObstacles('slowzone', 1);
			sim.selectors++;
		};
		el('dbgKill').onclick = () => sim.killAllMonsters();
		el('dbgWave').onclick = () => {
			const n = Number(prompt('Прыгнуть на волну:', String(sim.wave + 1)));
			if (Number.isFinite(n) && n >= 1) sim.jumpToWave(Math.floor(n));
		};
		el('dbgSeed').onclick = () => {
			const s = prompt('Сид забега (перезапуск):', String(sim.seed));
			if (s !== null && s.trim() !== '') {
				const url = new URL(location.href);
				url.searchParams.set('seed', String(Number(s) >>> 0));
				location.href = url.toString();
			}
		};
		el('dbgDps').onclick = () => {
			this.dpsShown = !this.dpsShown;
			el('dbgDps').classList.toggle('active', this.dpsShown);
			el('dpsOverlay').classList.toggle('open', this.dpsShown);
		};
		const gotoMode = (mode: string | null) => {
			const url = new URL(location.origin + location.pathname);
			if (mode) url.searchParams.set('mode', mode);
			location.href = url.toString();
		};
		el('dbgDaily').onclick = () => gotoMode('daily');
		el('dbgBoss').onclick = () => gotoMode('boss');
		el('dbgGod').onclick = () => {
			sim.godMode = !sim.godMode;
			el('dbgGod').textContent = `God: ${sim.godMode ? 'ON' : 'off'}`;
			el('dbgGod').classList.toggle('active', sim.godMode);
		};
		el('dbgTelem').onclick = () => {
			const json = JSON.stringify(sim.stats, null, 2);
			console.log('[telemetry]', json);
			void navigator.clipboard?.writeText(json).catch(() => undefined);
			alert('Телеметрия выведена в консоль и скопирована в буфер.');
		};

		const restart = (seed?: number) => {
			const url = new URL(location.href);
			if (seed !== undefined) url.searchParams.set('seed', String(seed));
			else url.searchParams.delete('seed');
			location.href = url.toString();
		};
		el('restartSameBtn').onclick = () => restart(sim.seed);
		el('restartNewBtn').onclick = () => restart();
		el('toMenuBtn').onclick = () => {
			location.href = location.origin + location.pathname; // без параметров → главное меню
		};
	}

	/** Вызывается каждый кадр. */
	update(): void {
		const s = this.sim;
		el('waveN').textContent = String(s.wave);
		el('livesN').textContent = String(s.lives);
		el('manaN').textContent = String(Math.floor(s.mana));
		el('fpsLbl').textContent = `${Math.round(this.fps)} fps · ${s.monsters.length} монстров`;
		if (this.dpsShown) {
			const rows = Object.entries(s.dpsByType())
				.sort((a, b) => b[1] - a[1])
				.map(([id, d]) => {
					const t = s.cfg.unitTypes.find(u => u.id === id);
					return `${(t?.name ?? SOURCE_NAMES[id] ?? id).padEnd(10)} ${Math.round(d)}`;
				});
			el('dpsOverlay').textContent = rows.length > 0
				? `DPS за 10 с\n${rows.join('\n')}` : 'DPS за 10 с\n—';
		}
		// таймер волны и предупреждение «ходов нет» — оверлеем над полем (не двигают бар).
		// Приоритет у предупреждения: оно важнее косметического таймера.
		const banner = el('centerBanner');
		const stuck = s.units.length >= s.gridCells && !s.hasMergeMove();
		if (stuck) {
			banner.textContent = '⚠ ходов нет';
		} else if (s.phase === 'intermission') {
			banner.textContent = `⏳ волна через ${Math.max(0, s.intermissionEndsAt - s.time).toFixed(1)} с`;
		} else {
			banner.textContent = '';
		}
		banner.classList.toggle('show', banner.textContent !== '');
		banner.classList.toggle('warn', stuck);
		const btn = el<HTMLButtonElement>('summonBtn');
		btn.textContent = `Призыв (${s.summonCost})`;
		btn.disabled = s.mana < s.summonCost || s.gameOver;

		for (const [id, b] of this.upgButtons) {
			const t = s.cfg.unitTypes.find(u => u.id === id)!;
			const cost = s.upgradeTypeCost(id);
			// маленький силуэт типа рядом с названием — сразу видно, какую башню качаешь
			b.innerHTML = `<span class="ico">${shapeSvg(id, t.color, 14)}</span>${t.name}` +
				`<br>ур.${s.typeLevels[id]} · ${cost === null ? 'MAX' : cost}`;
			b.disabled = cost === null || s.mana < cost || s.gameOver;
		}

		// заграждения
		const armed = this.controls.armed;
		for (const [kind, b] of this.obButtons) {
			b.textContent = `${OBSTACLE_NAMES[kind]} ×${s.inventory[kind]}`;
			b.disabled = !s.canPlaceObstacle(kind);
			b.classList.toggle('armed', armed?.kind === 'obstacle' && armed.ob === kind);
		}

		// бусты
		for (const [id, b] of this.boostButtons) {
			const cfg = s.boostCfg(id);
			const left = s.boostReadyIn(id);
			const icon = id === 'meteor' ? '☄️' : id === 'overdrive' ? '🔥' : '💧';
			if (id === 'overdrive' && s.time < s.overdriveUntil) {
				b.textContent = `${icon} ${cfg.name} ${(s.overdriveUntil - s.time).toFixed(0)}с!`;
			} else {
				b.textContent = left > 0 ? `${icon} ${cfg.name} ${Math.ceil(left)}с` : `${icon} ${cfg.name} ✓`;
			}
			b.disabled = left > 0 || s.gameOver;
			b.classList.toggle('armed', id === 'meteor' && armed?.kind === 'meteor');
		}

		// селектор
		const sel = el<HTMLButtonElement>('selectorBtn');
		if (s.selectorType !== null) {
			const t = s.cfg.unitTypes.find(u => u.id === s.selectorType);
			sel.textContent = `🎯 ${t?.name ?? '?'} ✓`;
			sel.classList.add('armed');
		} else {
			sel.textContent = `🎯 Селектор ×${s.selectors}`;
			sel.classList.remove('armed');
		}
		sel.disabled = s.selectors <= 0 && s.selectorType === null;

		// драфт: открыть при появлении карточек
		if (s.draftPending && this.shownDraft !== s.draftPending) {
			this.shownDraft = s.draftPending;
			const box = el('draftCards');
			box.innerHTML = '';
			s.draftPending.forEach((card, i) => {
				const b = document.createElement('button');
				b.textContent = card.title;
				b.onclick = () => {
					s.pickDraft(i);
					el('draftOverlay').classList.remove('open');
				};
				box.appendChild(b);
			});
			el('draftOverlay').classList.add('open');
		}

		if (s.gameOver && !this.overlayShown) this.showResults();
	}

	private buildUpgradeRow(): void {
		const row = el('upgrow');
		for (const t of this.sim.deck) {
			const b = document.createElement('button');
			b.style.borderColor = t.color;
			b.onclick = () => this.sim.upgradeType(t.id);
			row.appendChild(b);
			this.upgButtons.set(t.id, b);
		}
	}

	private buildConsumables(): void {
		const s = this.sim;
		// заграждения: кнопка взводит установку, второй тап — отмена
		const ob = (kind: ObstacleKind, id: string) => {
			const b = el<HTMLButtonElement>(id);
			b.onclick = () => {
				const a = this.controls.armed;
				this.controls.armed =
					a?.kind === 'obstacle' && a.ob === kind ? null : { kind: 'obstacle', ob: kind };
			};
			this.obButtons.set(kind, b);
		};
		ob('barricade', 'obBarricade');
		ob('spikes', 'obSpikes');
		ob('slowzone', 'obSlowzone');

		// бусты
		const bMeteor = el<HTMLButtonElement>('bMeteor');
		bMeteor.onclick = () => {
			this.controls.armed = this.controls.armed?.kind === 'meteor' ? null : { kind: 'meteor' };
		};
		this.boostButtons.set('meteor', bMeteor);
		const bOver = el<HTMLButtonElement>('bOverdrive');
		bOver.onclick = () => s.useBoost('overdrive');
		this.boostButtons.set('overdrive', bOver);
		const bSurge = el<HTMLButtonElement>('bManasurge');
		bSurge.onclick = () => s.useBoost('manasurge');
		this.boostButtons.set('manasurge', bSurge);

		// селектор: открывает выбор типа; повторный тап при взведённом — отмена
		el('selectorBtn').onclick = () => {
			if (s.selectorType !== null) { s.armSelector(null); return; }
			if (s.selectors > 0) el('selectorPanel').classList.add('open');
		};
		const typesRow = el('selectorTypes');
		for (const t of s.deck) {
			const b = document.createElement('button');
			b.textContent = t.name;
			b.style.borderColor = t.color;
			b.onclick = () => {
				s.armSelector(t.id);
				el('selectorPanel').classList.remove('open');
			};
			typesRow.appendChild(b);
		}
	}

	private showResults(): void {
		this.overlayShown = true;
		const s = this.sim.stats;
		// начисление валюты — единственное место, где забег влияет на мету
		const bossEvery = this.sim.waves.procedural.bossEvery;
		s.currencyEarned = runReward(this.sim.cfg, s, bossEvery);
		this.meta.currency += s.currencyEarned;
		saveMeta(this.meta);
		const dmgRows = Object.entries(s.damageByType)
			.sort((a, b) => b[1] - a[1])
			.map(([id, d]) => {
				const t = this.sim.cfg.unitTypes.find(u => u.id === id);
				const name = t?.name ?? SOURCE_NAMES[id] ?? id;
				return `<tr><td>${name}</td><td style="text-align:right">${Math.round(d)}</td></tr>`;
			})
			.join('');
		const boosts = Object.entries(s.boostsUsed)
			.map(([id, uses]) => `${this.sim.boostCfg(id as BoostId).name} ×${uses.length}`)
			.join(', ') || '—';
		const picks = s.draftPicks.map(p => `в${p.wave}: ${p.title}`).join(' · ') || '—';
		const deck = this.sim.deck.map(t => t.name).join(', ');
		const overkill = Object.values(s.overkillByType).reduce((a, b) => a + b, 0);
		const genShare = s.manaEarned > 0 ? Math.round(100 * s.manaFromGen / s.manaEarned) : 0;
		const modeName = s.mode === 'daily' ? 'Испытание дня' : s.mode === 'boss' ? 'Boss Rush' : 'Аркада';
		const critRate = s.totalHits > 0 ? Math.round(100 * s.critHits / s.totalHits) : 0;
		el('resultBody').innerHTML =
			`<p>${modeName} · Волна <b>${s.wavesReached}</b> · ${Math.round(s.timeSec)} с · убийств: ${s.kills} · мерджей: ${s.merges}</p>` +
			`<p class="reward">◈ +${s.currencyEarned} ядер <span class="muted">(всего ${this.meta.currency})</span></p>` +
			`<p class="muted">критов ${critRate}% · добавили урона ${Math.round(s.critBonusDamage).toLocaleString('ru')}</p>` +
			`<p class="muted">колода: ${deck}</p>` +
			`<p class="muted">мана: заработано ${Math.round(s.manaEarned)}, призыв ${Math.round(s.manaSpentSummon)}, ` +
			`апгрейды ${Math.round(s.manaSpentUpgrade)} · от Генератора ${genShare}% · overkill ${Math.round(overkill)}</p>` +
			`<table><tr><td><b>Урон по источникам</b></td><td></td></tr>${dmgRows}</table>` +
			`<p class="muted">заграждения купили времени: баррикада ${s.timeBought.barricade.toFixed(1)} с, ` +
			`слоу-зона ${s.timeBought.slowzone.toFixed(1)} с · бусты: ${boosts} · селекторов: ${s.selectorsUsed}</p>` +
			`<p class="muted">драфт: ${picks}</p>` +
			`<p class="muted">сид ${s.seed}</p>`;
		el('overlay').classList.add('open');
	}
}
