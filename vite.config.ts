import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };
// короткий git-хэш деплоя; вне git-окружения — 'dev'
const sha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'dev'; }
})();

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GIT_SHA__: JSON.stringify(sha),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10))
  },
  build: { outDir: 'dist', sourcemap: true }
});
