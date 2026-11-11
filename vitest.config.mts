import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.test.ts'],
        exclude: [...configDefaults.exclude, '**/*.browser.test.ts'],
    },
    resolve: {
        tsconfigPaths: true,
    },
});
