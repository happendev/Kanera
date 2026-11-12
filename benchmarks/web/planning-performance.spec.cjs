const { test, expect } = require('@playwright/test');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

// Opt-in, test-owned local fixture only. Interactions use a disposable browser context.
const board = '70000000-0000-4000-8000-000000000200';
const rounds = Math.max(1, Number(process.env.PERF_NAVIGATION_RUNS ?? 5));
const rate = Number(process.env.PERF_CPU_THROTTLE ?? 1);
const output = process.env.PERF_OUTPUT ?? `benchmarks/web/results/planning-${Date.now()}.json`;
const views = {
  calendar: { host: 'k-board-calendar-view', item: '.cal-card', scroll: '.calendar-scroll', toggle: 'Slim cards' },
  timeline: { host: 'k-board-timeline-view', item: '.tl-row-card', scroll: '.tl-scroller', toggle: 'Zoom', actions: ['Zoom in', 'Zoom out'] },
  dependencies: { host: 'k-dependency-map', item: ':is(.dm-tile, .dm-row)', scroll: '', toggle: 'Slim cards' },
};
const median = values => {
  const sorted = [...values].sort((a,b) => a-b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
async function paint(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function metrics(cdp) {
  return Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
}
// At 4x, ThreadTime includes the emulator's own CPU overhead; compare active CPU only at 1x.
function delta(a,b) {
  return Object.fromEntries(['ThreadTime', 'TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(k => [k + 'Ms', (b[k]-a[k])*1000]));
}
test('planning views rendering and interactions', async ({ page, browser }, info) => {
  page.setDefaultTimeout(15000);
  expect(new URL(info.project.use.baseURL).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  const errors = [];
  let network = [];
  page.on('requestfinished', request => {
    if (!['fetch', 'xhr'].includes(request.resourceType()) || request.url().includes('socket.io')) return;
    const timing = request.timing();
    network.push({ path: new URL(request.url()).pathname, duration: timing.responseEnd, ttfb: timing.responseStart });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
  });
  if (process.env.PERF_OBSERVE_CALENDAR) await page.addInitScript(() => {
    window.__peakCalendarCards = 0;
    new MutationObserver(() => {
      window.__peakCalendarCards = Math.max(window.__peakCalendarCards, document.querySelectorAll('k-board-calendar-view .cal-card').length);
    }).observe(document, { childList: true, subtree: true });
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.goto('/login');
  await page.locator('#email').fill('perf@kanera.local');
  await page.locator('#password').fill('Perf12345');
  await page.locator('form').evaluate(form => form.requestSubmit());
  await expect(page.locator('k-app-shell')).toBeVisible({ timeout: 90000 });
  const results = { browser: browser.version(), cpuThrottle: rate, build: process.env.PERF_BUILD ?? 'Angular development', rounds, timelineWires: process.env.PERF_TIMELINE_WIRES ?? 'default', samples: [], errors };
  for (const width of (process.env.PERF_WIDTHS ?? '1600,390').split(',').map(Number)) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [view, spec] of Object.entries(views)) {
      if (process.env.PERF_VIEWS && !process.env.PERF_VIEWS.split(',').includes(view)) continue;
      // Discard first navigation to warm modules and API caches.
      for (let round = -1; round < rounds; round++) {
        network = [];
        const before = await metrics(cdp);
        const boardReady = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(`/boards/${board}/open`));
        const graphReady = view === 'calendar' ? null : page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(view === 'timeline' ? '/cards/schedule' : '/cards/dependency-graph'));
        const start = performance.now();
        await page.goto(`/b/${board}?view=${view}`);
        await expect(page.locator(`${spec.host} ${spec.item}`).first()).toBeVisible({ timeout: 90000 });
        if (graphReady) expect((await graphReady).ok()).toBe(true);
        await page.waitForFunction(({ view, host }) => {
          if (!window.ng?.getComponent) return true;
          const component = window.ng.getComponent(document.querySelector(host));
          return view === 'dependencies' ? component.response()?.cards.length === 400 : component.cards().length === 1000;
        }, { view, host: spec.host }, { timeout: 15000 });
        if (view === 'timeline' && round === -1 && process.env.PERF_TIMELINE_WIRES === 'off') {
          const toggle = page.locator(`${spec.host} .timeline-toolbar-right button:has(.ti-git-merge)`);
          if (await toggle.getAttribute('aria-pressed') === 'true') await toggle.evaluate(el => el.click());
        }
        await paint(page);
        const readyMs = performance.now() - start;
        const boardResponse = await boardReady;
        expect(boardResponse.ok()).toBe(true);
        expect((await boardResponse.json()).cards).toHaveLength(1000);
        const after = await metrics(cdp);
        const state = await page.evaluate(({ host, item }) => ({
          peakCalendarCards: window.__peakCalendarCards ?? null,
          domNodes: document.querySelectorAll('*').length,
          mountedItems: document.querySelectorAll(`${host} ${item}`).length,
          mountedWires: document.querySelectorAll(`${host} .tl-wire-hit`).length,
          longTasks: window.__longTasks,
        }), spec);
        if (process.env.PERF_EXPECT_BOUNDED) {
          expect(state.mountedItems).toBeLessThan(view === 'timeline' ? 60 : 200);
          if (view === 'calendar' && state.peakCalendarCards !== null) expect(state.peakCalendarCards).toBeLessThan(width === 1200 ? 77 : 200);
        }
        if (round >= 0) results.samples.push({ width, view, round, readyMs, ...delta(before, after), ...state, api: [...network] });
      }
      await cdp.send('HeapProfiler.collectGarbage');
      const heapMiB = (await metrics(cdp)).JSHeapUsedSize / 1024 / 1024;
      if (process.env.PERF_PROFILE) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      }
      const interactions = [];
      for (let i = 0; i < 6; i++) {
        network = [];
        const button = await page.locator(spec.host).getByRole('button', { name: spec.actions?.[i % 2] ?? spec.toggle, exact: true }).elementHandle();
        const { ms, animation } = await button.evaluate((el, { view, host }) => new Promise(resolve => {
          const start = performance.now(), frames = [];
          const slider = view === 'timeline' ? document.querySelector(`${host} input[type="range"]`) : null;
          let previous = slider?.value, stable = 0, last = start, ms = 0;
          el.click();
          function frame(now) {
            frames.push(now-last); last = now;
            if (frames.length === 2) ms = performance.now()-start;
            stable = slider?.value === previous ? stable + 1 : 0; previous = slider?.value;
            if ((!slider && frames.length >= 2) || (slider && stable >= 4) || now-start > 10000) {
              frames.sort((a,b) => a-b);
              resolve({ ms, animation: slider ? { settleMs: now-start, frameP95Ms: frames[Math.floor(frames.length*.95)] } : null });
            } else requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
        }), { view, host: spec.host });
        if (animation) expect(animation.settleMs).toBeLessThan(10000);
        interactions.push({ ms, animation });
        await button.dispose();
      }
      if (process.env.PERF_PROFILE) {
        const { profile } = await cdp.send('Profiler.stop');
        writeFileSync(info.outputPath(`${view}-${width}.cpuprofile`), JSON.stringify(profile));
      }
      const critical = view === 'calendar' ? [] : await page.locator(`${spec.host} button:has(.ti-route)`).evaluate(async el => {
        const samples = [];
        for (let i=0; i<6; i++) {
          const start = performance.now(); el.click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          samples.push(performance.now()-start);
        }
        return samples;
      });
      const hover = await page.locator(`${spec.host} ${spec.item}`).first().evaluate(async (el, view) => {
        const samples = [];
        for (let i=0; i<6; i++) {
          const start = performance.now();
          el.dispatchEvent(new MouseEvent(view === 'timeline' ? 'pointerenter' : 'mouseenter'));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          samples.push(performance.now()-start);
          el.dispatchEvent(new MouseEvent(view === 'timeline' ? 'pointerleave' : 'mouseleave'));
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        return samples;
      }, view);
      const scrolling = {};
      for (const axis of ['vertical', 'horizontal']) {
        await paint(page);
        if (process.env.PERF_PROFILE) await cdp.send('Profiler.start');
        const scrollBefore = await metrics(cdp);
        const scroll = await page.evaluate(async ({ host, scroll, axis }) => {
          const el = axis === 'horizontal' && host === 'k-dependency-map'
            ? document.querySelector(`${host} .dm-scroll`) ?? document.querySelector(host)
            : document.querySelector(scroll ? `${host} ${scroll}` : host);
          const position = axis === 'horizontal' ? 'scrollLeft' : 'scrollTop';
          const extent = axis === 'horizontal' ? el.scrollWidth-el.clientWidth : el.scrollHeight-el.clientHeight;
          const frames = [];
          let last = performance.now();
          const start = last;
          const initial = el[position];
          await new Promise(resolve => {
            function frame(now) {
              frames.push(now-last); last = now;
              el[position] = Math.min(1, (now-start)/2000) * Math.min(5000, extent);
              if (now-start < 2000) requestAnimationFrame(frame); else resolve();
            }
            requestAnimationFrame(frame);
          });
          const distance = el[position]-initial;
          el[position] = initial;
          frames.shift();
          frames.sort((a,b) => a-b);
          return { distance, frameP95Ms: frames[Math.floor(frames.length*.95)], framesOver33Ms: frames.filter(n => n>33.4).length, frames: frames.length };
        }, { ...spec, axis });
        Object.assign(scroll, delta(scrollBefore, await metrics(cdp)));
        if (process.env.PERF_PROFILE) {
          const { profile } = await cdp.send('Profiler.stop');
          writeFileSync(info.outputPath(`${view}-${width}-${axis}-scroll.cpuprofile`), JSON.stringify(profile));
        }
        scrolling[axis] = scroll;
      }
      const scroll = scrolling.vertical;
      const mounts = [];
      if (view === 'dependencies' && process.env.PERF_MOUNT_SWEEP) {
        // Fixed targets avoid comparing different amounts of work when a busy machine drops frames.
        // The CPU throttle itself adds thread CPU overhead, even while idle. Measure active CPU
        // at 1x, and retain a separate fixed-work latency sweep at the requested throttle.
        for (const mountRate of rate === 1 ? [1] : [1, rate]) {
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: mountRate });
          for (let round=0; round<3; round++) {
            for (const index of [0, 6, 12, 18, 24, 30]) {
              const before = await metrics(cdp);
              const state = await page.locator(spec.host).evaluate(async (host, index) => {
                const target = host.querySelectorAll('.dm-chain')[index];
                if (!target) throw new Error(`Missing fixture chain ${index}`);
                host.scrollTop += target.getBoundingClientRect().top-host.getBoundingClientRect().top;
                const start = performance.now();
                await new Promise((resolve, reject) => {
                  function frame() {
                    if (target.getAttribute('data-viewport-mounted') === 'true') {
                      requestAnimationFrame(() => requestAnimationFrame(resolve));
                    } else if (performance.now()-start > 15000) reject(new Error('Chain did not mount'));
                    else requestAnimationFrame(frame);
                  }
                  requestAnimationFrame(frame);
                });
                return { target: target.getAttribute('aria-label'), targetItems: target.querySelectorAll('.dm-tile, .dm-row').length,
                  mountedItems: host.querySelectorAll('.dm-tile, .dm-row').length, elapsedMs: performance.now()-start };
              }, index);
              if (index) mounts.push({ cpuThrottle: mountRate, round, index, ...delta(before, await metrics(cdp)), ...state });
            }
          }
        }
        await cdp.send('Emulation.setCPUThrottlingRate', { rate });
        await page.locator(spec.host).evaluate(el => { el.scrollTop = 0; });
      }
      await paint(page);
      await page.screenshot({ path: info.outputPath(`${view}-${width}.png`) });
      results.samples.filter(s => s.view === view && s.width === width).at(-1).interaction = { heapMiB, toggle: spec.toggle, medianMs: median(interactions.map(i=>i.ms)), forwardMedianMs: median(interactions.filter((_, i) => i % 2 === 0).map(i => i.ms)), reverseMedianMs: median(interactions.filter((_, i) => i % 2 === 1).map(i => i.ms)), samples: interactions, hoverMedianMs: median(hover), criticalMedianMs: critical.length ? median(critical) : null, scroll, horizontalScroll: scrolling.horizontal, mounts };
      console.log(JSON.stringify({ view, width, readyMedianMs: median(results.samples.filter(s=>s.view===view&&s.width===width).map(s=>s.readyMs)), heapMiB, toggleMedianMs: median(interactions.map(i=>i.ms)), scroll }));
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, JSON.stringify(results, null, 2));
    }
  }
  expect(errors).toEqual([]);
});
