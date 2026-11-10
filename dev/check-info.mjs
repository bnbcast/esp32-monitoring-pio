/*
 * dev/check-info.mjs - Playwright gate for the INFO tab (the glossary).
 *
 * The INFO tab is static text, so it can only break in the browser: a wrong
 * panel id, a tab bar that clips its last button, or a definition list that
 * overflows on a phone. This opens the page at desktop and phone sizes, clicks
 * INFO, and checks the rendered result.
 *
 * Usage:
 *   node dev/check-info.mjs                                        # live site
 *   node dev/check-info.mjs http://localhost:5003/?dev&t=dev-test-1234
 *   node dev/check-info.mjs https://bnbcast.github.io/esp32-monitoring-pio/ race-tracker
 *
 * Args: [baseUrl] [topicKey] [waitMs]
 * Exit code 0 = pass.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'https://bnbcast.github.io/esp32-monitoring-pio/';
const KEY = process.argv[3] || 'race-tracker';
const WAIT = Number(process.argv[4] || 6000);
const url = BASE.includes('?') ? BASE : BASE + '#t=' + KEY;

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 }
];

const browser = await chromium.launch();
let failed = false;

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(WAIT);

  await page.click('.tab-btn[data-tab="info"]');
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => {
    const panel = document.getElementById('tab-info');
    const btn = document.querySelector('.tab-btn[data-tab="info"]');
    const bar = document.querySelector('.tab-bar');
    const dts = panel ? panel.querySelectorAll('dt') : [];
    const dds = panel ? panel.querySelectorAll('dd') : [];
    const empty = [];
    dds.forEach((dd, i) => {
      if (dd.textContent.trim().length < 10) empty.push((dts[i] || {}).textContent || String(i));
    });
    const first = panel ? panel.querySelector('dt') : null;
    const cs = first ? getComputedStyle(first) : null;
    // The panel itself is not the scroller: .tab-panels-wrapper is, so a long
    // glossary must make the wrapper taller than its viewport.
    const scroller = panel ? panel.closest('.tab-panels-wrapper') || panel : null;
    const buttons = bar ? Array.from(bar.querySelectorAll('.tab-btn')) : [];
    const barBox = bar ? bar.getBoundingClientRect() : null;
    const clipped = buttons
      .filter(b => {
        const r = b.getBoundingClientRect();
        return r.right > barBox.right + 1 || r.width < 20;
      })
      .map(b => b.dataset.tab);
    return {
      panelActive: !!(panel && panel.classList.contains('active') && getComputedStyle(panel).display !== 'none'),
      tabActive: !!(btn && btn.classList.contains('active')),
      terms: dts.length,
      defs: dds.length,
      empty,
      scrolls: scroller ? scroller.scrollHeight > scroller.clientHeight + 20 : false,
      fontSize: cs ? parseFloat(cs.fontSize) : 0,
      clipped,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth
    };
  });

  const problems = [];
  if (!state.panelActive) problems.push('INFO panel is not visible');
  if (!state.tabActive) problems.push('INFO tab is not active');
  if (state.terms < 40) problems.push(`only ${state.terms} terms`);
  if (state.defs !== state.terms) problems.push(`${state.terms} terms vs ${state.defs} definitions`);
  if (state.empty.length) problems.push('empty definitions: ' + state.empty.join(', '));
  if (!state.scrolls) problems.push('panel does not scroll; terms are not reachable');
  if (state.fontSize < 9) problems.push(`term text too small (${state.fontSize}px)`);
  if (state.clipped.length) problems.push('tab buttons clipped: ' + state.clipped.join(', '));
  if (state.docOverflow > 1) problems.push(`page overflows horizontally by ${state.docOverflow}px`);
  if (pageErrors.length) problems.push('page errors: ' + pageErrors.join(' | '));

  console.log(`${vp.name.padEnd(8)} ${state.terms} terms, ${state.fontSize}px, scroll=${state.scrolls}, overflow=${state.docOverflow}px`);
  if (problems.length) {
    failed = true;
    for (const p of problems) console.log(`  FAIL ${p}`);
  } else {
    console.log('  PASS');
  }
  await page.close();
}

await browser.close();
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
