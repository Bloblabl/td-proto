/**
 * Клиент авторизации: общается с сервером (server/), хранит токен в localStorage.
 * Без токена игра работает в гостевом режиме (прогресс локально) — см. storage.ts.
 *
 * Токен в localStorage удобен, но уязвим к XSS; для прототипа приемлемо.
 */
const TOKEN_KEY = 'td-proto-token';
const LOGIN_KEY = 'td-proto-login';

export function currentLogin(): string | null {
  return localStorage.getItem(LOGIN_KEY);
}
export function isAuthed(): boolean {
  return localStorage.getItem(TOKEN_KEY) !== null;
}
export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LOGIN_KEY);
}

interface AuthResponse { token: string; login: string; meta: unknown }

async function api(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    // сети/сервера нет (напр. прод без задеплоенного бэкенда) — понятное сообщение
    throw new Error('Сервер авторизации недоступен. Запустите его локально (npm run server).');
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `Ошибка ${res.status}`);
  return data;
}

function store(d: AuthResponse): unknown {
  localStorage.setItem(TOKEN_KEY, d.token);
  localStorage.setItem(LOGIN_KEY, d.login);
  return d.meta;
}

/** Регистрация. Возвращает серверный meta (у нового пользователя — пустой). */
export async function register(login: string, password: string): Promise<unknown> {
  return store((await api('/register', 'POST', { login, password })) as unknown as AuthResponse);
}

/** Вход. Возвращает сохранённый на сервере meta. */
export async function login(loginName: string, password: string): Promise<unknown> {
  return store((await api('/login', 'POST', { login: loginName, password })) as unknown as AuthResponse);
}

/** Прогресс с сервера (для залогиненного). */
export async function fetchProgress(): Promise<unknown> {
  return (await api('/progress', 'GET')).meta;
}

/** Отправить прогресс на сервер (fire-and-forget из saveMeta). */
export async function pushProgress(meta: unknown): Promise<void> {
  await api('/progress', 'PUT', { meta });
}
