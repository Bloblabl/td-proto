import { buyUpgrade, critStats, towerDamageBonus, upgradeCost } from '../core/meta';
import { shapeSvg } from '../render/shapes';
import type { BalanceCfg, MetaState } from '../core/types';
import { currentLogin, isAuthed, login as apiLogin, logout, register as apiRegister } from './auth';
import { loadAdmin, resetMeta, saveAdmin, saveMeta } from './storage';

export type GameMode = 'arcade' | 'daily' | 'boss';

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} not found`);
  return e as T;
}

/** Главное меню и экран мета-прокачки. Игра не создаётся, пока не выбран режим. */
export class Menu {
  private meta: MetaState;

  constructor(private cfg: BalanceCfg, meta: MetaState) {
    this.meta = meta;
    // версия сборки: номер + git-хэш + дата (подставлены Vite при билде)
    el('verLbl').textContent = `v${__APP_VERSION__} · ${__GIT_SHA__} · ${__BUILD_DATE__}`;
    el('metaBack').onclick = () => {
      el('metaScreen').classList.remove('open');
      el('menuScreen').classList.add('open');
      this.refreshWallet();
    };
    el('openMeta').onclick = () => {
      el('menuScreen').classList.remove('open');
      el('metaScreen').classList.add('open');
      this.renderMeta();
    };
    el('menuHelp').onclick = () => el('helpPanel').classList.toggle('open');
    this.wireAuth();

    // админ-режим: тумблер, применяется к телу страницы (CSS показывает дебаг-бар)
    const applyAdmin = (on: boolean): void => {
      document.body.classList.toggle('admin', on);
      el('adminToggle').textContent = `🛠 Админ-режим: ${on ? 'вкл' : 'выкл'}`;
      el('adminToggle').classList.toggle('active', on);
    };
    applyAdmin(loadAdmin());
    el('adminToggle').onclick = () => {
      const on = !loadAdmin();
      saveAdmin(on);
      applyAdmin(on);
    };
    el('metaReset').onclick = () => {
      if (!confirm('Сбросить всю прокачку и ядра?')) return;
      const fresh = resetMeta(this.cfg);
      this.meta.currency = fresh.currency;
      this.meta.levels = fresh.levels;
      this.renderMeta();
    };
    this.refreshWallet();
  }

  /** Экран аккаунта: вход, регистрация, выход. Прогресс переключается перезагрузкой. */
  private wireAuth(): void {
    const open = () => {
      el('menuScreen').classList.remove('open');
      el('authScreen').classList.add('open');
      this.renderAuth();
    };
    el('openAuth').onclick = open;
    el('authBack').onclick = () => {
      el('authScreen').classList.remove('open');
      el('menuScreen').classList.add('open');
    };

    const err = (msg: string) => { el('authErr').textContent = msg; };
    const creds = (): [string, string] => [
      el<HTMLInputElement>('authLogin').value.trim(),
      el<HTMLInputElement>('authPass').value
    ];
    const run = async (fn: (l: string, p: string) => Promise<unknown>) => {
      err('');
      const [l, p] = creds();
      try {
        await fn(l, p);
        location.reload(); // перезагрузка подтянет прогресс с сервера
      } catch (e) {
        err(e instanceof Error ? e.message : 'Ошибка сети');
      }
    };
    el('authLoginBtn').onclick = () => void run(apiLogin);
    el('authRegBtn').onclick = () => void run(apiRegister);
    el('authLogoutBtn').onclick = () => { logout(); location.reload(); };
  }

  private renderAuth(): void {
    el('authErr').textContent = '';
    const authed = isAuthed();
    el('authForm').style.display = authed ? 'none' : 'flex';
    el('authLogoutBtn').style.display = authed ? 'block' : 'none';
    el('authStatus').textContent = authed
      ? `Вы вошли как «${currentLogin()}». Прогресс сохраняется на сервере.`
      : 'Войдите, чтобы прогресс хранился на сервере и был доступен с любого устройства. Без входа — прогресс только в этом браузере.';
  }

  /** Показывает меню и ждёт выбора режима. */
  waitForChoice(): Promise<GameMode> {
    el('menuScreen').classList.add('open');
    this.refreshWallet();
    return new Promise(resolve => {
      const pick = (id: string, mode: GameMode): void => {
        el(id).onclick = () => {
          el('menuScreen').classList.remove('open');
          resolve(mode);
        };
      };
      pick('playArcade', 'arcade');
      pick('playDaily', 'daily');
      pick('playBoss', 'boss');
    });
  }

  private refreshWallet(): void {
    el('menuCurrency').textContent = String(this.meta.currency);
    el('metaCurrency').textContent = String(this.meta.currency);
    el('openAuth').textContent = isAuthed() ? `👤 ${currentLogin()}` : '👤 Аккаунт (гость)';
  }

  private renderMeta(): void {
    this.refreshWallet();
    const { chance, mult } = critStats(this.cfg, this.meta);
    const avg = 1 + chance * (mult - 1);
    el('critSummary').textContent =
      `Крит: ${Math.round(chance * 100)}% шанс · ×${mult.toFixed(2)} урона ` +
      `(в среднем ×${avg.toFixed(2)} ко всему урону)`;

    const list = el('metaList');
    list.innerHTML = '';
    for (const t of this.cfg.unitTypes) {
      const lv = this.meta.levels[t.id] ?? 1;
      const cost = upgradeCost(this.cfg, this.meta, t.id);
      const bonus = Math.round(towerDamageBonus(this.cfg, this.meta, t.id) * 100);

      const row = document.createElement('div');
      row.className = 'meta-row';
      row.innerHTML =
        `${shapeSvg(t.id, t.color, 26)}` +
        `<div class="info"><div class="nm">${t.name} <span class="lv">ур. ${lv}</span></div>` +
        `<div class="sub">+${bonus}% ${t.targeting === 'none' ? 'эффекта' : 'урона'} этому типу</div></div>`;

      const btn = document.createElement('button');
      if (cost === null) {
        btn.textContent = 'МАКС';
        btn.disabled = true;
      } else {
        btn.textContent = `◈ ${cost}`;
        btn.disabled = this.meta.currency < cost;
        btn.onclick = () => {
          if (buyUpgrade(this.cfg, this.meta, t.id)) {
            saveMeta(this.meta);
            this.renderMeta();
          }
        };
      }
      row.appendChild(btn);
      list.appendChild(row);
    }
  }
}
