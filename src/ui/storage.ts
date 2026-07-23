import { emptyMeta, normalizeMeta } from '../core/meta';
import type { BalanceCfg, MetaState } from '../core/types';
import { fetchProgress, isAuthed, logout, pushProgress } from './auth';

/**
 * Хранение меты. Гость — localStorage; залогиненный — сервер (мини-БД).
 * Ядро (core/meta.ts) браузера не касается; при порте на C# меняется только это.
 */
const KEY = 'td-proto-meta-v1';

/** Локальное чтение (гость / кэш). */
export function loadMeta(cfg: BalanceCfg): MetaState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyMeta(cfg);
    return normalizeMeta(cfg, JSON.parse(raw));
  } catch {
    // повреждённое или недоступное хранилище — начинаем с чистой меты
    return emptyMeta(cfg);
  }
}

/** Загрузка при старте: с сервера, если вошёл; иначе локально. */
export async function loadMetaAsync(cfg: BalanceCfg): Promise<MetaState> {
  if (isAuthed()) {
    try {
      return normalizeMeta(cfg, await fetchProgress());
    } catch {
      // токен протух или сервер недоступен — выходим в гостя, не теряя игру
      logout();
    }
  }
  return loadMeta(cfg);
}

export function saveMeta(meta: MetaState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(meta)); // локальный кэш всегда
  } catch { /* приватный режим / переполнение */ }
  if (isAuthed()) {
    void pushProgress(meta).catch(() => undefined); // на сервер, не блокируя игру
  }
}

export function resetMeta(cfg: BalanceCfg): MetaState {
  try {
    localStorage.removeItem(KEY);
  } catch { /* см. выше */ }
  return emptyMeta(cfg);
}

const ADMIN_KEY = 'td-proto-admin';

export function loadAdmin(): boolean {
  try {
    return localStorage.getItem(ADMIN_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveAdmin(on: boolean): void {
  try {
    if (on) localStorage.setItem(ADMIN_KEY, '1');
    else localStorage.removeItem(ADMIN_KEY);
  } catch { /* приватный режим — админ просто не запомнится */ }
}
