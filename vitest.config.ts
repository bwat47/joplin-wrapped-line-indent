import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
    },
    resolve: {
        alias: [
            { find: /^api$/, replacement: new URL('./api/index.ts', import.meta.url).pathname },
            { find: /^api\/(.*)$/, replacement: new URL('./api/$1', import.meta.url).pathname },
        ],
    },
});
