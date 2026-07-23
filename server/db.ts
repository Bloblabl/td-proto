import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Мини-БД на встроенном SQLite (node:sqlite). Один файл — вся база.
 * Хранит пользователей и их прогресс (meta) как JSON в поле users.meta.
 */
const DB_PATH = process.env.TD_DB_PATH ?? 'server/data/td.db';
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    login      TEXT UNIQUE NOT NULL,
    pass_hash  TEXT NOT NULL,
    meta       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
`);

export interface UserRow {
  id: number;
  login: string;
  pass_hash: string;
  meta: string;
  created_at: string;
}

// node:sqlite (экспериментальный) финализирует prepared statement после
// использования, поэтому готовим его заново в каждом вызове — надёжнее.
export function createUser(login: string, passHash: string, meta: string): number {
  const info = db.prepare('INSERT INTO users (login, pass_hash, meta, created_at) VALUES (?, ?, ?, ?)')
    .run(login, passHash, meta, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function userByLogin(login: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE login = ?').get(login) as UserRow | undefined;
}

export function userById(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function saveMeta(id: number, meta: string): void {
  db.prepare('UPDATE users SET meta = ? WHERE id = ?').run(meta, id);
}
