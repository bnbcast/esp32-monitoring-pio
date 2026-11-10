/*
 * dev/check-info.mjs - Playwright gate for the INFO tab (interactive glossary).
 *
 * The glossary is rendered by ui/info.js, so unit tests cannot catch a broken
 * mount point, an accordion that never opens, or a tab bar that clips. This
 * opens the page at desktop and phone sizes and exercises the interactions a
 * reader actually uses.
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

function check(problems, ok, message) {
  if (!ok) problems.push(message);
}

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));
  const problems = [];

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(WAIT);

  await page.click('.tab-btn[data-tab="info"]');
  await page.waitForTimeout(300);

  // 1) Collapsed to a short index: areas only, no paragraphs.
  const start = await page.evaluate(() => {
    const panel = document.getElementById('tab-info');
    const heads = panel.querySelectorAll('.info-group-head');
    const openRows = panel.querySelectorAll('.info-row:not([hidden])');
    const visibleDefs = Array.from(panel.querySelectorAll('.info-def'))
      .filter(d => d.offsetParent !== null).length;
    const bar = document.querySelector('.tab-bar');
    const barBox = bar.getBoundingClientRect();
    return {
      panelActive: panel.classList.contains('active') && getComputedStyle(panel).display !== 'none',
      tabActive: document.querySelector('.tab-btn[data-tab="info"]').classList.contains('active'),
      heads: heads.length,
      rows: panel.querySelectorAll('.info-row').length,
      visibleRows: Array.from(openRows).filter(r => r.offsetParent !== null).length,
      visibleDefs,
      count: (document.getElementById('infoCount') || {}).textContent || '',
      clipped: Array.from(bar.querySelectorAll('.tab-btn'))
        .filter(b => {
          const r = b.getBoundingClientRect();
          return r.right > barBox.right + 1 || r.width < 20;
        })
        .map(b => b.dataset.tab),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      scrolls: (() => {
        const s = panel.closest('.tab-panels-wrapper');
        return s ? s.scrollHeight > s.clientHeight + 10 : false;
      })()
    };
  });

  check(problems, start.panelActive, 'INFO panel is not visible');
  check(problems, start.tabActive, 'INFO tab is not active');
  check(problems, start.heads === 9, `expected 9 areas, found ${start.heads}`);
  check(problems, start.rows >= 70, `expected the full glossary, found ${start.rows} terms`);
  check(problems, start.visibleRows === 0, 'terms are visible before an area is opened');
  check(problems, start.visibleDefs === 0, 'a definition is visible before anything is tapped');
  check(problems, /^\d+ terms in \d+ areas$/.test(start.count), `count line looks wrong: "${start.count}"`);
  check(problems, start.clipped.length === 0, 'tab buttons clipped: ' + start.clipped.join(','));
  check(problems, start.overflow <= 1, `page overflows horizontally by ${start.overflow}px`);
  check(problems, start.scrolls, 'the panel cannot scroll');

  // 2) Opening an area lists its terms, still without a paragraph.
  await page.click('#tab-info .info-group-head');
  await page.waitForTimeout(200);
  const opened = await page.evaluate(() => {
    const panel = document.getElementById('tab-info');
    const body = panel.querySelector('.info-group-body');
    return {
      rows: Array.from(panel.querySelectorAll('.info-row')).filter(r => r.offsetParent !== null).length,
      defs: Array.from(panel.querySelectorAll('.info-def')).filter(d => d.offsetParent !== null).length,
      expanded: panel.querySelector('.info-group-head').getAttribute('aria-expanded')
    };
  });
  check(problems, opened.rows === 5, `first area should list 5 terms, found ${opened.rows}`);
  check(problems, opened.defs === 0, 'opening an area also opened a definition');
  check(problems, opened.expanded === 'true', 'area did not mark itself expanded');

  // 3) One term opens at a time.
  await page.locator('#tab-info .info-group-body .info-row').nth(1).click();
  await page.waitForTimeout(200);
  const first = await page.evaluate(() => {
    const open = Array.from(document.querySelectorAll('#tab-info .info-item.open'));
    return {
      open: open.length,
      term: open[0] ? open[0].querySelector('.info-term').textContent.trim() : null,
      defVisible: open[0] ? open[0].querySelector('.info-def').offsetParent !== null : false
    };
  });
  check(problems, first.open === 1, `expected 1 open term, found ${first.open}`);
  check(problems, first.defVisible, 'opened term shows no definition');
  check(problems, first.term === 'DEVICE', `second pills term should be DEVICE, got ${first.term}`);

  await page.locator('#tab-info .info-group-body .info-row').nth(3).click();
  await page.waitForTimeout(200);
  const second = await page.evaluate(() =>
    document.querySelectorAll('#tab-info .info-item.open').length);
  check(problems, second === 1, 'opening a second term did not close the first');

  // 4) Search finds a term, and a single hit opens itself.
  await page.fill('#infoSearch', 'hdop');
  await page.waitForTimeout(300);
  const searched = await page.evaluate(() => {
    const open = document.querySelector('#tab-info .info-item.open');
    return {
      rows: Array.from(document.querySelectorAll('#tab-info .info-row'))
        .filter(r => r.offsetParent !== null).length,
      term: open ? open.querySelector('.info-term').textContent.trim() : null,
      def: open ? open.querySelector('.info-def').textContent.replace(/\s+/g, ' ').trim() : '',
      count: (document.getElementById('infoCount') || {}).textContent || ''
    };
  });
  check(problems, searched.rows === 1, `search "hdop" should leave 1 term, found ${searched.rows}`);
  check(problems, searched.term === 'HDOP', `search opened ${searched.term}`);
  check(problems, /dilution/i.test(searched.def), 'the HDOP explanation is missing');
  check(problems, /^1 of \d+ terms$/.test(searched.count), `count line after search: "${searched.count}"`);

  // 5) A chip jumps to one area.
  await page.fill('#infoSearch', '');
  await page.click('#infoChips .info-chip[data-group="wifi"]');
  await page.waitForTimeout(250);
  const chipped = await page.evaluate(() => ({
    heads: Array.from(document.querySelectorAll('#tab-info .info-group-head'))
      .filter(h => h.offsetParent !== null).length,
    rows: Array.from(document.querySelectorAll('#tab-info .info-row'))
      .filter(r => r.offsetParent !== null).length,
    active: (document.querySelector('#infoChips .info-chip.active') || {}).textContent
  }));
  check(problems, chipped.heads === 1, `WiFi chip shows ${chipped.heads} areas`);
  check(problems, chipped.rows === 11, `WiFi area should list 11 terms, found ${chipped.rows}`);
  check(problems, chipped.active === 'WiFi', `active chip is ${chipped.active}`);

  // 6) Tapping a field label on another tab opens its explanation.
  await page.click('.tab-btn[data-tab="live"]');
  await page.waitForTimeout(200);
  await page.locator('#tab-live .hud-item .lbl', { hasText: /^HDOP$/ }).first().click();
  await page.waitForTimeout(300);
  const jumped = await page.evaluate(() => {
    const panel = document.getElementById('tab-info');
    const open = panel.querySelector('.info-item.open');
    return {
      active: panel.classList.contains('active'),
      term: open ? open.querySelector('.info-term').textContent.trim() : null,
      def: open ? open.querySelector('.info-def').textContent.replace(/\s+/g, ' ').trim() : '',
      group: open ? open.closest('.info-group').dataset.group : null
    };
  });
  check(problems, jumped.active, 'tapping the HDOP label did not switch to INFO');
  check(problems, jumped.term === 'HDOP', `label tap opened ${jumped.term}`);
  check(problems, jumped.group === 'live', `label tap opened area ${jumped.group}`);
  check(problems, /dilution/i.test(jumped.def), 'label tap opened the wrong definition');

  if (pageErrors.length) problems.push('page errors: ' + pageErrors.join(' | '));

  console.log(`${vp.name.padEnd(8)} ${start.heads} areas / ${start.rows} terms, ` +
    `overflow=${start.overflow}px, jump=${jumped.term}`);
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
