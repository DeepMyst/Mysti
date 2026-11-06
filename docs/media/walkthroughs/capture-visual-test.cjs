/* SPDX-License-Identifier: Apache-2.0 */
'use strict';
// Capture the shipped dashboard form with synthetic inputs; no host/model run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../..');
const output = __dirname;
const sources = ['media/vt-dashboard/index.html', 'media/vt-dashboard/vt-dashboard.css',
  'media/vt-dashboard/vt-dashboard.js', 'scripts/record-release-demos.cjs',
  'docs/media/walkthroughs/capture-visual-test.cjs'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const { colors } = require('../../../scripts/record-release-demos.cjs');
const version = require('../../../package.json').version;
const viewport = { width: 1120, height: 840 };
const requirements = 'Inspect the sign-in page. Check whether the heading and submit button fit in the viewport, and report console errors or failed requests.';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => route.abort());
    // Same controlled composition as the existing release recorder: the real
    // assets run with a mock VS Code bridge and editor theme variables. The
    // webview CSP is omitted only in this isolated capture, not in the product.
    const html = fs.readFileSync(path.join(root, sources[0]), 'utf8')
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
      .replace(/<link[^>]+>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    await page.setContent(html);
    await page.addStyleTag({ content: fs.readFileSync(path.join(root, sources[1]), 'utf8') + colors });
    await page.evaluate(() => {
      window.__posted = [];
      window.acquireVsCodeApi = () => ({ postMessage: message => window.__posted.push(message) });
    });
    await page.addScriptTag({ content: fs.readFileSync(path.join(root, sources[2]), 'utf8') });
    await page.fill('#cfg-url', 'http://localhost:3000');
    await page.fill('#cfg-requirements', requirements);
    await page.selectOption('#cfg-screenshot-mode', 'viewport');
    await page.uncheck('#cfg-interactions');
    await page.evaluate(version => {
      const banner = document.createElement('div');
      banner.id = 'release-caption';
      const title = document.createElement('strong');
      title.textContent = 'Configure one local observation.';
      const detail = document.createElement('small');
      detail.textContent = 'MYSTI ' + version + ' · BETA 2 / CURRENT INTERFACE · SAMPLE INPUTS';
      banner.append(title, detail);
      document.body.append(banner);
      document.activeElement?.blur();
    }, version);
    assert.equal(await page.locator('#vt-start').isVisible(), true);
    assert.equal(await page.locator('#vt-status').textContent(), 'Idle');
    assert.equal(await page.locator('#cfg-interactions').isChecked(), false);
    assert.equal(await page.evaluate(() => window.__posted.length), 0);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(output, 'visual-test-config.png') });
    // Prove that the captured inputs reach the current form's message contract.
    // The mocked bridge records the request; it never starts a dev server/model.
    await page.click('#vt-start');
    const posted = await page.evaluate(() => window.__posted);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].type, 'dashboardStartVisualTest');
    assert.equal(posted[0].payload.config.url, 'http://localhost:3000');
    assert.equal(posted[0].payload.config.requirements, requirements);
    assert.equal(posted[0].payload.config.interactionsEnabled, false);
    assert.deepEqual(pageErrors, []);
    const artifact = 'docs/media/walkthroughs/visual-test-config.png';
    fs.writeFileSync(path.join(output, 'visual-test-config.json'), JSON.stringify({
      schemaVersion: 1, capturedAt: new Date().toISOString(), productVersion: version,
      scene: 'Current Visual Test configuration form, before Start',
      scope: 'Shipped HTML/CSS/JS with synthetic localhost inputs, mocked VS Code bridge and visible sample label. No observation, model call, repair, network request or acceptance verdict was executed.',
      command: 'node docs/media/walkthroughs/capture-visual-test.cjs',
      node: process.version, playwright: require('playwright/package.json').version,
      chromium: browser.version(), viewport, normalTLSVerification: true,
      captureEnvironment: 'Isolated page composition, with webview CSP omitted only in the harness and all network requests aborted.',
      sourceHashes: Object.fromEntries(sources.map(file => [file, hash(file)])),
      artifact: { path: artifact, bytes: fs.statSync(path.join(root, artifact)).size, sha256: hash(artifact) },
      checks: { currentFormVisible: true, idle: true, actionsOff: true, oneRecordedStartRequest: true, pageErrors: [] },
    }, null, 2) + '\n');
    console.log('Captured current Visual Test form; checked synthetic request contract; no host or model execution.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
