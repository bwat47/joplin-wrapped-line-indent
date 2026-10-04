// Flat config (ESM). Adds ignores, Node globals, and TS-friendly rule tweaks.

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import vitest from '@vitest/eslint-plugin';
import sonarjs from 'eslint-plugin-sonarjs';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default defineConfig(
    {
        ignores: ['api/**', 'dist/**', 'webpack.config.js'],
    },

    // Project TS/JS sources
    {
        files: ['**/*.{ts,tsx,js}'],
        extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked, sonarjs.configs.recommended],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
            globals: globals.node,
        },
        rules: {
            'no-useless-escape': 'off',
            '@typescript-eslint/no-inferrable-types': 'error',
            '@typescript-eslint/explicit-module-boundary-types': 'error',
        },
    },

    // Vitest tests
    {
        files: ['**/*.test.ts'],
        extends: [vitest.configs.recommended],
        rules: {
            // Vitest-aware version allows passing mocked methods to expect()
            '@typescript-eslint/unbound-method': 'off',
            'vitest/unbound-method': 'error',
        },
    },

    // Prettier compatibility
    prettier
);
