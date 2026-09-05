const base = require('./playwright.config.cjs');
module.exports = { ...base, testMatch: 'kanban-interactions.spec.cjs', timeout: 120_000 };
