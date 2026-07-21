import { emptyMeta, normalizeMeta } from '../core/meta';
import type { BalanceCfg, MetaState } from '../core/types';

/**
 * Сохранение меты в localStorage. Единственное место, где ядро касается
 * браузера — при порте на C# заменяется на PlayerPrefs/файл, core/meta.ts не меняется.
 */
const KEY = 'td-proto-meta-v1';

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

export function saveMeta(meta: MetaState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(meta));
  } catch {
    // приватный режим / переполнение — прогресс просто не сохранится
  }
}

export function resetMeta(cfg: BalanceCfg): MetaState {
  try {
    localStorage.removeItem(KEY);
  } catch { /* см. выше */ }
  return emptyMeta(cfg);
}
