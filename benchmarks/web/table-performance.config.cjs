const base = require('./playwright.config.cjs');
module.exports = { ...base, testMatch: 'table-performance.spec.cjs', timeout: 180_000 };
