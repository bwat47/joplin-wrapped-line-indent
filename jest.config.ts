import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    moduleNameMapper: {
        '^api$': '<rootDir>/api/index.ts',
        '^api/(.*)$': '<rootDir>/api/$1',
    },
};

export default config;
