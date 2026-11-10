// Optional real-browser check of the phone app, including the service worker.
// `npm test` uses a simulated DOM; this drives Chromium instead:
//   npm install --no-save playwright && npx playwright install chromium
//   npm run test:browser
// It serves dist/ from a temporary local server and never touches real ledger data.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch {
  console.log('Playwright is not installed; skipped. Run: npm install --no-save playwright && npx playwright install chromium');
  process.exit(0);
}
const root = path.join(__dirname, 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// A static server whose behaviour can change mid-test: expired login, redirecting start URL, a newer deploy.
function serve(options = {}) {
  const state = { login: false, redirectRoot: false, override: {}, hits: [], ...options };
  const server = http.createServer((request, response) => {
    let name = decodeURIComponent(new URL(request.url, 'http://local').pathname); state.hits.push(name);
    if (state.redirectRoot && name === '/') { response.writeHead(302, { Location: '/index.html' }); response.end(); return; }
    if (name.endsWith('/')) name += 'index.html';
    if (state.login && name === '/index.html') { response.writeHead(200, { 'Content-Type': types['.html'] }); response.end('<!doctype html><title>Sign in</title><form>login required</form>'); return; }
    if (state.override[name] !== undefined) { response.writeHead(200, { 'Content-Type': types[path.extname(name)], 'Cache-Control': 'no-cache' }); response.end(state.override[name]); return; }
    const file = path.join(root, name);
    if (!file.startsWith(root) || !fs.existsSync(file)) { response.writeHead(404); response.end('missing'); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); response.end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}/` })));
}

const results = [];
async function check(name, run) { try { await run(); results.push(['PASS', name]); } catch (error) { results.push(['FAIL', `${name} -> ${String(error.message).split('\n')[0]}`]); } }
const started = page => page.waitForFunction(() => /帳目|離線/.test(document.getElementById('networkLabel').textContent));
const offlineReady = page => page.waitForFunction(() => document.getElementById('offlineLabel').textContent === '已可離線開啟', null, { timeout: 15000 });
const closed = (page, id) => page.waitForSelector(`#${id}:not([open])`, { state: 'attached' });
const deviceId = page => page.evaluate(async () => (await (await import('./store.mjs')).read()).device_id);

(async () => {
  const browser = await chromium.launch();
  const open = async () => { const context = await browser.newContext({ ...devices['iPhone 13'] }), page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(String(error))); return { context, page, errors }; };

  { // Everyday use, offline reopening and updating.
    const site = await serve(), { context, page, errors } = await open(); let device;
    await page.goto(site.url); await started(page);
    await check('first load is empty; no install prompt outside an iPhone browser tab', async () => {
      assert.match(await page.textContent('#recentList'), /第一筆/); assert.equal(await page.locator('#installBanner').isHidden(), true);
    });
    await check('adding a record stores and shows it', async () => {
      await page.click('.quick-actions [data-add="expense"]'); await page.waitForSelector('#entryDialog[open]');
      await page.fill('#amount', '125.50'); await page.fill('#merchant', '瀏覽器測試午餐'); await page.click('#saveBtn'); await closed(page, 'entryDialog');
      assert.match(await page.textContent('#recentList'), /瀏覽器測試午餐/); assert.match(await page.textContent('#monthExpense'), /125\.50/);
      device = await deviceId(page); assert.match(device, /^[0-9a-f-]{36}$/);
    });
    await check('service worker prepares the offline shell', () => offlineReady(page));
    await check('a 350-entry ledger shows one page at a time; search and filters cover every row', async () => {
      const entries = Array.from({ length: 350 }, (_, i) => ({ id: 'e' + i, account: '信用卡', kind: i % 5 ? 'expense' : 'income', amount: '10.00', currency: 'TWD', merchant: i === 320 ? '深處的書店' : '商店' + i, occurred_at: new Date(Date.UTC(2026, 9, 1) - i * 3600e3).toISOString(), status: 'verified', category: '餐飲' }));
      const snapshot = { format: 'personal-ledger-snapshot', version: 1, export_id: 'browser-check', created_at: new Date().toISOString(), entries, reviews: [], portfolio: [], accepted_sources: [] };
      await page.click('.bottom-nav [data-view="transfer"]');
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#importSnapshotBtn')]);
      await chooser.setFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
      await page.waitForSelector('#importDialog[open]'); await page.click('#confirmImport'); await closed(page, 'importDialog');
      await page.click('.bottom-nav [data-view="ledger"]');
      const count = () => page.locator('#ledgerList .record').count();
      assert.equal(await count(), 100); assert.match(await page.textContent('#moreRecords'), /100 \/ 351/);
      await page.click('#moreRecords'); assert.equal(await count(), 200);
      await page.fill('#search', '深處'); assert.equal(await count(), 1);
      await page.fill('#search', ''); assert.equal(await count(), 100);
      await page.click('[data-filter="income"]'); assert.equal(await count(), 70); assert.equal(await page.locator('#moreRecords').count(), 0);
      await page.click('[data-filter="all"]');
    });
    await check('offline reload opens with every record intact', async () => {
      await context.setOffline(true); await page.reload(); await started(page);
      assert.match(await page.textContent('#recentList'), /瀏覽器測試午餐/); assert.equal(await deviceId(page), device);
      assert.equal(await page.locator('#ledgerList .record').count(), 100);
    });
    await check('offline: the guide page and an unknown bookmark still open', async () => {
      await page.goto(site.url + 'apple-pay-guide.html'); assert.match(await page.content(), /Apple Pay/);
      await page.goto(site.url + 'old-bookmark'); await started(page); assert.match(await page.textContent('#recentList'), /瀏覽器測試午餐/);
    });
    await check('online again: page and scripts still come from one installed version', async () => {
      await context.setOffline(false);
      site.state.override['/index.html'] = '<!doctype html><meta name="ledger-app-shell" content="1"><title>NEWER DEPLOY</title><body>markup from a newer deploy</body>';
      site.state.hits.length = 0; await page.goto(site.url); await started(page);
      assert.equal(await page.title(), '隨身帳本');
      assert.deepEqual(site.state.hits.filter(hit => hit === '/' || hit === '/index.html' || /\.(mjs|css)$/.test(hit)), []);
      delete site.state.override['/index.html'];
    });
    await check('a new release installs in the background, announces itself and takes over after reopening', async () => {
      site.state.override['/sw.js'] = fs.readFileSync(path.join(root, 'sw.js'), 'utf8').replace(/personal-ledger-shell-[a-f0-9]{16}/, 'personal-ledger-shell-ffffffffffffffff');
      site.state.override['/style.css'] = fs.readFileSync(path.join(root, 'style.css'), 'utf8') + '\n/* next release */';
      const stylesheet = target => target.evaluate(async () => (await fetch('./style.css')).text());
      await page.reload(); await started(page);
      await page.waitForFunction(() => !document.getElementById('toast').hidden && document.getElementById('toast').textContent.includes('新版本已準備'), null, { timeout: 15000 });
      assert.equal((await page.evaluate(() => caches.keys())).length, 2);
      assert.equal((await stylesheet(page)).includes('next release'), false);  // the open page keeps its version
      await page.close(); const next = await context.newPage(); await next.goto(site.url); await started(next);
      await next.waitForFunction(async () => (await caches.keys()).length === 1, null, { timeout: 15000 });
      assert.equal((await stylesheet(next)).includes('next release'), true);
      assert.match(await next.textContent('#recentList'), /瀏覽器測試午餐/);
    });
    await check('no script errors during the main flow', async () => assert.deepEqual(errors, []));
    await context.close(); site.server.close();
  }

  { // Opened in an iPhone browser tab (navigator.standalone === false) instead of from the home screen.
    const site = await serve(), { context, page } = await open();
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => false }));
    await page.goto(site.url); await started(page);
    await check('in a browser tab the app explains adding it to the home screen, and can be dismissed', async () => {
      await page.waitForSelector('#installBanner:not([hidden])'); assert.match(await page.textContent('#installText'), /加入主畫面後/);
      await page.click('#installHow'); await page.waitForSelector('#helpDialog[open]'); await page.click('#helpDone');
      await page.click('#installClose'); assert.equal(await page.locator('#installBanner').isHidden(), true);
      await page.reload(); await started(page); assert.equal(await page.locator('#installBanner').isHidden(), true);
    });
    await context.close(); site.server.close();
  }

  { // An expired private-site login answers with a sign-in page instead of the app.
    const site = await serve(), { context, page } = await open();
    await check('expired login: the sign-in page is never cached and the app says offline is not ready', async () => {
      await page.goto(site.url, { waitUntil: 'commit' }); site.state.login = true;
      await page.waitForFunction(() => ['離線畫面尚未準備', '已可離線開啟'].includes(document.getElementById('offlineLabel').textContent), null, { timeout: 15000 });
      assert.equal(await page.textContent('#offlineLabel'), '離線畫面尚未準備');
      assert.deepEqual(await page.evaluate(async () => { const urls = []; for (const name of await caches.keys()) urls.push(...(await (await caches.open(name)).keys()).map(request => request.url)); return urls; }), []);
    });
    await context.close(); site.server.close();
  }

  { // Hosting that redirects the start URL.
    const site = await serve({ redirectRoot: true }), { context, page } = await open();
    await page.goto(site.url); await started(page);
    await check('redirected start URL is cached as a page that opens offline', async () => {
      await offlineReady(page); await context.setOffline(true);
      const response = await page.goto(site.url); await started(page);
      assert.equal(response.status(), 200); assert.equal(await page.title(), '隨身帳本');
    });
    await context.close(); site.server.close();
  }

  await browser.close();
  for (const [status, name] of results) console.log(status, name);
  console.log(`${results.filter(result => result[0] === 'PASS').length}/${results.length} browser checks passed`);
  process.exit(results.some(result => result[0] === 'FAIL') ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
