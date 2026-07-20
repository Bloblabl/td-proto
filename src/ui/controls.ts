import type { ObstacleKind } from '../core/types';

/**
 * Взведённое действие, ожидающее тапа по полю:
 * установка заграждения на тайл трека или прицел Метеора.
 * UI-состояние, не входит в детерминированную симуляцию.
 */
export type Armed =
  | { kind: 'obstacle'; ob: ObstacleKind }
  | { kind: 'meteor' }
  | null;

export class Controls {
  armed: Armed = null;
}
