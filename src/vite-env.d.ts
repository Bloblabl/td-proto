/// <reference types="vite/client" />

// значения подставляются на этапе сборки (vite.config.ts → define)
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
declare const __BUILD_DATE__: string;

interface ImportMetaEnv {
  // База API. Пусто (dev) → относительный /api через Vite-proxy.
  // На проде (GitHub Pages) — абсолютный HTTPS-URL VPS, напр. https://203-0-113-5.sslip.io
  readonly VITE_API_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
