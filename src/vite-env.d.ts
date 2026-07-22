/// <reference types="vite/client" />

// значения подставляются на этапе сборки (vite.config.ts → define)
declare const __APP_VERSION__: string;
declare const __GIT_SHA__: string;
declare const __BUILD_DATE__: string;
