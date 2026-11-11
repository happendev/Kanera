const base = require('./playwright.config.cjs');
module.exports = { ...base, testMatch: 'planning-performance.spec.cjs', outputDir: require('node:path').resolve(process.env.PERF_TEST_OUTPUT ?? 'e2e/artifacts/planning-perf'), use: { ...base.use, trace: process.env.PERF_TRACE ? 'on' : 'off', screenshot: 'on' } };
