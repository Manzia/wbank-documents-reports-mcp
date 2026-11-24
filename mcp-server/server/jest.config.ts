/*
 * For a detailed explanation regarding each configuration property and type check, visit:
 * https://jestjs.io/docs/configuration
 */

export default {
    // Type-checking is `npm run compile`; Jest only transpiles. Hono and its Lambda adapter ship ES modules
    // only, so they are transpiled to CommonJS too.
    transform: {
        '^.+\\.[tj]s$': ['ts-jest', { tsconfig: { module: 'commonjs', moduleResolution: 'node10', allowJs: true, esModuleInterop: false } }],
        '^.+\\.md$': '<rootDir>/tests/setup/text-transform.cjs',
    },
    transformIgnorePatterns: ['/node_modules/(?!(hono|@hono)/)'],
    clearMocks: true,
    collectCoverage: true,
    collectCoverageFrom: ['src/**/*.ts'],
    coverageDirectory: 'coverage',
    setupFiles: ['<rootDir>/tests/setup/awslambda.ts'],
    testMatch: ['**/tests/unit/**/*.test.ts'],
    // The dispatcher's sandbox blocks watchman (it writes a launchd agent), which crashes Jest (plan G11)
    watchman: false,
};
