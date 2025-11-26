module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/*.test.ts'],
    verbose: true,
    forceExit: true,
    clearMocks: true,
    resetMocks: true,
    restoreMocks: true,
    coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
    modulePathIgnorePatterns: ['<rootDir>/data/', '<rootDir>/session/'],
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            tsconfig: 'tsconfig.test.json'
        }]
    }
};
