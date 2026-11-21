// Pure unit tests, no Postgres or Redis: `pnpm exec jest -c jest.unit.config.js`.
// The main config's global setup creates test databases for every run.
const base = require('./jest.config');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...base,
  testRegex: 'escape/.*\\.unit\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/'],
  globalSetup: undefined,
  setupFiles: [],
  maxWorkers: 2,
};
