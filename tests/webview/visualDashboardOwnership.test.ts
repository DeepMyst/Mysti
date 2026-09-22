import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../..');
const html = readFileSync(path.join(root, 'media/vt-dashboard/index.html'), 'utf8');
const script = readFileSync(path.join(root, 'media/vt-dashboard/vt-dashboard.js'), 'utf8');
const windows: JSDOM[] = [];
interface Posted { type: string; payload: { config?: Record<string, unknown>; operationId?: string } }

function harness() {
  const dom = new JSDOM(html, { runScripts: 'outside-only' }); windows.push(dom);
  const document = dom.window.document; const posted: Posted[] = [];
  Object.assign(dom.window, { acquireVsCodeApi: () => ({ postMessage: (message: Posted) => posted.push(message) }) });
  dom.window.eval(script);
  const element = (id: string) => document.getElementById(id)!;
  const receive = (type: string, payload?: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type, payload } }));
  const start = (requirements = 'Inspect the local fixture') => {
    (element('cfg-requirements') as HTMLTextAreaElement).value = requirements;
    element('vt-start').click();
    return posted.filter(message => message.type === 'dashboardStartVisualTest').at(-1)!.payload.operationId!;
  };
  const update = (operationId: string | undefined, type: string, extras: Record<string, unknown> = {}) =>
    receive('visualTestDashboardUpdate', { operationId, type, ...extras });
  return { document, element, posted, receive, start, update, status: () => element('vt-status').textContent };
}
afterEach(() => windows.splice(0).forEach(dom => dom.window.close()));

describe('visual dashboard operation ownership through shipped assets', () => {
  it('reserves a fresh identity before posting Run and echoes it for immediate pre-ack Cancel', () => {
    const h = harness(); const id = h.start();
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(h.posted[0]).toMatchObject({ type: 'dashboardStartVisualTest', payload: {
      operationId: id, config: { requirements: 'Inspect the local fixture', url: 'http://localhost:3000', screenshotMode: 'viewport' },
    } });
    h.element('vt-cancel').click();
    expect(h.posted[1]).toEqual({ type: 'dashboardCancelVisualTest', payload: { operationId: id } });
    expect(h.status()).toBe('Cancelling...');
    h.update(id, 'visual_test_started', { message: 'LATE START' });
    h.update(id, 'visual_test_complete', { message: 'LATE SUCCESS' });
    expect(h.status()).toBe('Cancelling...');
    h.receive('visualTestDashboardCancelled', { operationId: 'wrong' });
    expect(h.status()).toBe('Cancelling...');
    h.receive('visualTestDashboardCancelled', { operationId: id });
    expect(h.status()).toBe('Cancelled');
    const actions = h.element('vt-actions').innerHTML;
    h.receive('visualTestDashboardCancelled', { operationId: id });
    expect(h.element('vt-actions').innerHTML).toBe(actions);
  });

  it('never starts or cancels an operation for an empty brief or unknown host update', () => {
    const h = harness(); h.element('vt-start').click(); h.element('vt-cancel').click();
    expect(h.posted).toEqual([]);
    const before = h.status();
    h.update('unknown', 'visual_test_started', { message: 'OBSOLETE' });
    h.receive('visualTestDashboardAutoStart', { operationId: 'unknown', requirements: 'OBSOLETE' });
    expect(h.status()).toBe(before);
  });

  it('refuses old, missing and cancelled identities before changing the new operation UI', () => {
    const h = harness(); const old = h.start('Old operation'); const current = h.start('Current operation');
    expect(current).not.toBe(old);
    const before = h.document.body.innerHTML;
    for (const id of [old, undefined]) {
      h.update(id, 'visual_test_screenshot', { screenshot: { iteration: 1, base64Data: 'AAAA' } });
      h.update(id, 'visual_test_issue', { issue: { severity: 'major', description: 'STALE ISSUE' } });
      h.update(id, 'visual_test_complete', { message: 'STALE COMPLETE' });
      h.receive('visualTestDashboardCancelled', { operationId: id });
      h.receive('visualTestDashboardAutoStart', { operationId: id, requirements: 'STALE CONFIG' });
    }
    expect(h.document.body.innerHTML).toBe(before);
    h.update(current, 'visual_test_started', { message: 'Current observation' });
    expect(h.status()).toBe('Current observation');
    h.element('vt-cancel').click();
    expect(h.posted.at(-1)).toEqual({ type: 'dashboardCancelVisualTest', payload: { operationId: current } });
  });

  it('renders a successful look and its actual observation without a fabricated failure report', () => {
    const h = harness(); const id = h.start();
    h.update(id, 'visual_test_screenshot', { screenshot: { iteration: 1, base64Data: 'AAAA' } });
    expect(h.element('vt-screenshot').querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    h.update(id, 'visual_observation', { observation: { url: 'http://localhost:3000', console: [], network: [], layout: [], denials: [] } });
    expect(h.status()).toBe('Look complete');
    expect(h.element('vt-status').className).toContain('vt-status-complete');
    expect(h.element('vt-cancel').classList.contains('hidden')).toBe(true);
    const before = h.document.body.innerHTML;
    h.update(id, 'visual_test_error', { message: 'LATE ERROR' });
    h.update(id, 'visual_test_started', { message: 'LATE START' });
    h.receive('visualTestDashboardCancelled', { operationId: id });
    expect(h.document.body.innerHTML).toBe(before);
  });

  it.each(['pass', 'partial', 'fail'])('preserves a real legacy report verdict: %s', verdict => {
    const h = harness(); const id = h.start();
    h.update(id, 'visual_test_complete', { report: { summary: {
      verdict, totalIterations: 1, maxIterations: 1, totalIssuesFound: 2, totalIssuesFixed: 1, totalDuration: 1500,
    } } });
    expect(h.element('vt-verdict').textContent).toBe(verdict.toUpperCase());
    expect(h.element('vt-report-issues').textContent).toBe('2 issues, 1 fixed');
    expect(h.element('vt-report-duration').textContent).toBe('2s');
  });

  it('keeps failure one-way but permits a new explicitly started operation', () => {
    const h = harness(); const id = h.start(); h.update(id, 'visual_test_error', { message: 'Inert error' });
    expect(h.status()).toBe('Error'); expect(h.element('vt-cancel').classList.contains('hidden')).toBe(true);
    h.update(id, 'visual_test_complete', { message: 'LATE SUCCESS' }); expect(h.status()).toBe('Error');
    const next = h.start('New explicit operation'); h.update(next, 'visual_test_started', { message: 'New work' });
    expect(h.status()).toBe('New work');
  });

  it('keeps two dashboard owners independent', () => {
    const a = harness(); const b = harness(); const aid = a.start(); const bid = b.start();
    expect(aid).not.toBe(bid); a.element('vt-cancel').click();
    b.update(aid, 'visual_test_error', { message: 'Wrong dashboard' }); expect(b.status()).toBe('Starting...');
    b.update(bid, 'visual_test_started', { message: 'Independent work' }); expect(b.status()).toBe('Independent work');
    expect(b.posted).toHaveLength(1);
  });

  it('reports unconfirmed cleanup honestly in a matching cancellation acknowledgement', () => {
    const h = harness(); const id = h.start(); h.element('vt-cancel').click();
    h.receive('visualTestDashboardCancelled', { operationId: id, cleanupIncomplete: true, message: 'Owned browser close timed out.' });
    expect(h.status()).toBe('Cancelled — cleanup unconfirmed');
    expect(h.element('vt-actions').textContent).toContain('Owned browser close timed out.');
    expect(h.element('vt-cancel').classList.contains('hidden')).toBe(true);
    h.update(id, 'visual_test_complete', { message: 'LATE SUCCESS' });
    expect(h.status()).toBe('Cancelled — cleanup unconfirmed');
  });
});
