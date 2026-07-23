import Phaser from 'phaser';

/**
 * Силуэт для каждого типа башни. Цвет остаётся, но опознание идёт по форме —
 * одинаковые цветные квадраты не читались: игрок не понимал, что с чем сливать.
 * Форма подсказывает роль: остриё = одиночный урон, звезда = взрыв и т.д.
 */

/**
 * Точки многоугольника, вписанные в квадрат size×size.
 *
 * Координаты задаются в диапазоне [-1, 1] (удобно описывать силуэт от центра),
 * но на выходе сдвигаются в [0, size]: Phaser у Polygon вычисляет origin из
 * bounding box точек, поэтому центрированные вокруг нуля точки съезжают
 * на половину размера влево-вверх.
 */
function poly(size: number, pts: [number, number][]): number[] {
  const h = size / 2;
  return pts.flatMap(([x, y]) => [x * h + h, y * h + h]);
}

export interface ShapeSpec {
  /** Рисует силуэт в (0,0) контейнера */
  make(scene: Phaser.Scene, size: number, color: number): Phaser.GameObjects.Shape;
  /** Короткая подсказка о роли — для легенды и экрана прокачки */
  hint: string;
}

const SPECS: Record<string, ShapeSpec> = {
  // Стрелок — остриё стрелы вверх: чистый одиночный урон
  gunner: {
    hint: '▲ одиночный урон',
    make: (s, size, c) => s.add.polygon(0, 0, poly(size, [[0, -1], [0.9, 0.8], [0, 0.4], [-0.9, 0.8]]), c)
  },
  // Залп — звезда-вспышка: урон по области
  volley: {
    hint: '✦ урон по области',
    make: (s, size, c) => s.add.star(0, 0, 6, size * 0.22, size * 0.5, c)
  },
  // Мороз — шестигранник-кристалл: замедление
  frost: {
    hint: '⬡ замедляет',
    make: (s, size, c) => s.add.polygon(0, 0,
      poly(size, [[0, -1], [0.87, -0.5], [0.87, 0.5], [0, 1], [-0.87, 0.5], [-0.87, -0.5]]), c)
  },
  // Генератор — ромб-самоцвет: экономика, не атакует
  gen: {
    hint: '◆ даёт ману',
    make: (s, size, c) => s.add.polygon(0, 0, poly(size, [[0, -1], [1, 0], [0, 1], [-1, 0]]), c)
  },
  // Снайпер — кольцо прицела: бьёт самую жирную цель
  sniper: {
    hint: '◎ бьёт танков',
    make: (s, size, c) => s.add.circle(0, 0, size * 0.46, c)
  },
  // Яд — капля: урон по времени
  poison: {
    hint: '💧 яд со временем',
    make: (s, size, c) => s.add.polygon(0, 0,
      poly(size, [[0, -1], [0.7, 0.1], [0.5, 0.75], [0, 1], [-0.5, 0.75], [-0.7, 0.1]]), c)
  },
  // Разряд — молния: цепь по нескольким целям
  arc: {
    hint: '⚡ цепь молний',
    make: (s, size, c) => s.add.polygon(0, 0,
      poly(size, [[0.15, -1], [-0.8, 0.15], [-0.1, 0.15], [-0.25, 1], [0.8, -0.2], [0.05, -0.2]]), c)
  },
  // Пиромант — язык пламени: накладывает горение
  pyro: {
    hint: '🔥 горение (DoT)',
    make: (s, size, c) => s.add.polygon(0, 0,
      poly(size, [[0, -1], [0.4, -0.2], [0.25, 0.4], [0.6, 0.9], [0, 0.65], [-0.6, 0.9], [-0.25, 0.4], [-0.4, -0.2]]), c)
  },
  // Ливень — капля вниз: накладывает «мокро»
  rain: {
    hint: '💧 мокро (реакции)',
    make: (s, size, c) => s.add.polygon(0, 0,
      poly(size, [[0, 1], [0.7, -0.1], [0.5, -0.75], [0, -1], [-0.5, -0.75], [-0.7, -0.1]]), c)
  },
  // Дробитель — молот-клин вниз: накладывает «разлом»
  crush: {
    hint: '⬇ разлом (−броня)',
    make: (s, size, c) => s.add.polygon(0, 0,
      poly(size, [[-1, -0.9], [1, -0.9], [1, -0.35], [0.32, -0.35], [0.32, 1], [-0.32, 1], [-0.32, -0.35], [-1, -0.35]]), c)
  },
  // Арканист — пятиконечная звезда-руна: детонирует статусы
  arcane: {
    hint: '✵ детонация статусов',
    make: (s, size, c) => s.add.star(0, 0, 5, size * 0.2, size * 0.5, c)
  },
  // Медуза — глаз (широкий ромб-линза): шанс окаменения
  medusa: {
    hint: '◈ окаменение',
    make: (s, size, c) => s.add.polygon(0, 0,
      poly(size, [[-1, 0], [-0.4, -0.55], [0.4, -0.55], [1, 0], [0.4, 0.55], [-0.4, 0.55]]), c)
  }
};

const FALLBACK: ShapeSpec = {
  hint: '',
  make: (s, size, c) => s.add.rectangle(0, 0, size, size, c)
};

export function shapeSpec(typeId: string): ShapeSpec {
  return SPECS[typeId] ?? FALLBACK;
}

/** SVG-силуэт того же типа для DOM-интерфейса (меню, прокачка, панели). */
export function shapeSvg(typeId: string, color: string, size = 22): string {
  const pts = (arr: [number, number][]): string =>
    arr.map(([x, y]) => `${(x * 0.5 + 0.5) * size},${(y * 0.5 + 0.5) * size}`).join(' ');
  const wrap = (inner: string): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">${inner}</svg>`;
  switch (typeId) {
    case 'gunner':
      return wrap(`<polygon points="${pts([[0, -1], [0.9, 0.8], [0, 0.4], [-0.9, 0.8]])}" fill="${color}"/>`);
    case 'volley': {
      const star: [number, number][] = [];
      for (let i = 0; i < 12; i++) {
        const a = (Math.PI / 6) * i - Math.PI / 2;
        const r = i % 2 === 0 ? 1 : 0.44;
        star.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return wrap(`<polygon points="${pts(star)}" fill="${color}"/>`);
    }
    case 'frost':
      return wrap(`<polygon points="${pts([[0, -1], [0.87, -0.5], [0.87, 0.5], [0, 1], [-0.87, 0.5], [-0.87, -0.5]])}" fill="${color}"/>`);
    case 'gen':
      return wrap(`<polygon points="${pts([[0, -1], [1, 0], [0, 1], [-1, 0]])}" fill="${color}"/>`);
    case 'sniper':
      return wrap(`<circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.46}" fill="${color}"/>`);
    case 'poison':
      return wrap(`<polygon points="${pts([[0, -1], [0.7, 0.1], [0.5, 0.75], [0, 1], [-0.5, 0.75], [-0.7, 0.1]])}" fill="${color}"/>`);
    case 'arc':
      return wrap(`<polygon points="${pts([[0.15, -1], [-0.8, 0.15], [-0.1, 0.15], [-0.25, 1], [0.8, -0.2], [0.05, -0.2]])}" fill="${color}"/>`);
    case 'pyro':
      return wrap(`<polygon points="${pts([[0, -1], [0.4, -0.2], [0.25, 0.4], [0.6, 0.9], [0, 0.65], [-0.6, 0.9], [-0.25, 0.4], [-0.4, -0.2]])}" fill="${color}"/>`);
    case 'rain':
      return wrap(`<polygon points="${pts([[0, 1], [0.7, -0.1], [0.5, -0.75], [0, -1], [-0.5, -0.75], [-0.7, -0.1]])}" fill="${color}"/>`);
    case 'crush':
      return wrap(`<polygon points="${pts([[-1, -0.9], [1, -0.9], [1, -0.35], [0.32, -0.35], [0.32, 1], [-0.32, 1], [-0.32, -0.35], [-1, -0.35]])}" fill="${color}"/>`);
    case 'arcane': {
      const star: [number, number][] = [];
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const r = i % 2 === 0 ? 1 : 0.4;
        star.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      return wrap(`<polygon points="${pts(star)}" fill="${color}"/>`);
    }
    case 'medusa':
      return wrap(`<polygon points="${pts([[-1, 0], [-0.4, -0.55], [0.4, -0.55], [1, 0], [0.4, 0.55], [-0.4, 0.55]])}" fill="${color}"/>`);
    default:
      return wrap(`<rect width="${size}" height="${size}" fill="${color}"/>`);
  }
}
