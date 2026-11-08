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
        ignores: ['api/**', 'dist/**', '.api-staging-*/**', '.prettierrc.js'],
    },

    // Bundle tests run under node:test.
    {
        files: ['test/*.mjs'],
        extends: [js.configs.recommended, sonarjs.configs.recommended],
        languageOptions: { globals: globals.node },
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
            '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
            '@typescript-eslint/consistent-type-exports': ['error', { fixMixedExportsWithInlineTypeSpecifier: true }],
            // Use `import type { A }` rather than `import { type A }` when every specifier is a type
            '@typescript-eslint/no-import-type-side-effects': 'error',
            '@typescript-eslint/no-inferrable-types': 'error',
            '@typescript-eslint/no-unnecessary-condition': 'error',
            '@typescript-eslint/explicit-module-boundary-types': 'error',
            eqeqeq: ['error', 'always'],
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

    {
        files: ['**/*.browser.test.ts'],
        rules: {
            'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expectAligned'] }],
        },
    },

    // Prettier compatibility
    prettier
);
