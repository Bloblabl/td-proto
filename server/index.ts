import cors from 'cors';
import express, { type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, saveMeta, userById, userByLogin } from './db';

/**
 * Простой auth-бэкенд: регистрация/логин (bcrypt + JWT) и хранение прогресса.
 * Мини-БД — один SQLite-файл (см. db.ts).
 *
 * ВНИМАНИЕ: JWT_SECRET для прода задать через переменную окружения. Дефолт —
 * только для локальной разработки.
 */
const PORT = Number(process.env.PORT ?? 3000);
// В проде за nginx слушаем только localhost (HOST=127.0.0.1). По умолчанию — все интерфейсы (dev).
const HOST = process.env.HOST ?? '0.0.0.0';
const JWT_SECRET = process.env.JWT_SECRET ?? 'td-proto-dev-secret-change-me';
const TOKEN_TTL = '30d';

// Разрешённые origin'ы (CORS). ALLOWED_ORIGIN — список через запятую
// (напр. "https://bloblabl.github.io"). Пусто → разрешаем всё (локальная разработка).
const ALLOWED = (process.env.ALLOWED_ORIGIN ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
app.use(cors(ALLOWED.length === 0 ? undefined : { origin: ALLOWED }));
app.use(express.json());

function makeToken(id: number, login: string): string {
  return jwt.sign({ id, login }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/** Достаёт userId из Bearer-токена; 401, если токена нет или он невалиден. */
function auth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: number; login: string };
    (req as Request & { userId: number }).userId = payload.id;
    next();
  } catch {
    res.status(401).json({ error: 'Требуется вход' });
  }
}

function validCreds(login: unknown, password: unknown): string | null {
  if (typeof login !== 'string' || login.trim().length < 3) return 'Логин ≥ 3 символов';
  if (typeof password !== 'string' || password.length < 4) return 'Пароль ≥ 4 символов';
  if (login.length > 32) return 'Логин ≤ 32 символов';
  return null;
}

app.post('/api/register', (req: Request, res: Response) => {
  const { login, password } = req.body ?? {};
  const err = validCreds(login, password);
  if (err) { res.status(400).json({ error: err }); return; }
  const normLogin = (login as string).trim();
  if (userByLogin(normLogin)) { res.status(409).json({ error: 'Логин занят' }); return; }
  const passHash = bcrypt.hashSync(password as string, 10); // хеш, не плейнтекст
  const id = createUser(normLogin, passHash, '{}');
  res.json({ token: makeToken(id, normLogin), login: normLogin, meta: {} });
});

app.post('/api/login', (req: Request, res: Response) => {
  const { login, password } = req.body ?? {};
  if (typeof login !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Неверный запрос' }); return;
  }
  const user = userByLogin(login.trim());
  if (!user || !bcrypt.compareSync(password, user.pass_hash)) {
    res.status(401).json({ error: 'Неверный логин или пароль' }); return;
  }
  res.json({
    token: makeToken(user.id, user.login), login: user.login,
    meta: JSON.parse(user.meta) as unknown
  });
});

app.get('/api/progress', auth, (req: Request, res: Response) => {
  const user = userById((req as Request & { userId: number }).userId);
  if (!user) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
  res.json({ meta: JSON.parse(user.meta) as unknown });
});

app.put('/api/progress', auth, (req: Request, res: Response) => {
  const meta = req.body?.meta;
  if (meta === undefined || typeof meta !== 'object') {
    res.status(400).json({ error: 'meta обязателен' }); return;
  }
  saveMeta((req as Request & { userId: number }).userId, JSON.stringify(meta));
  res.json({ ok: true });
});

app.get('/api/health', (_req: Request, res: Response) => res.json({ ok: true }));

if (JWT_SECRET === 'td-proto-dev-secret-change-me') {
  console.warn('[td-server] ВНИМАНИЕ: используется дефолтный JWT_SECRET. На проде задайте свой через env.');
}

app.listen(PORT, HOST, () => console.log(`[td-server] слушает ${HOST}:${PORT} (origins: ${ALLOWED.join(', ') || '*'})`));
