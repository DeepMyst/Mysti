/**
 * Desk webview escaping (Plan 26 Phase A, Plan 21 I37).
 *
 * The rail renders strings that came from another person's machine — a trust
 * domain, a task title, an error. It is also the surface where a human decides
 * whether a key is genuine, which makes UI SPOOFING the realistic attack: the
 * CSP already stops injected script (`script-src` carries a nonce) and already
 * stops beaconing (`img-src` omits http/https), but neither stops markup that
 * merely LOOKS like Mysti's own chrome — a second "verified" badge, a fake
 * safety number, a forged Revoke button.
 *
 * The real `media/chat/desk.js` is loaded and executed here rather than having
 * its logic restated in the test. A restatement drifts from the shipped file,
 * and the drift is invisible until it matters.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const DESK_JS = path.resolve(__dirname, '..', '..', 'media', 'chat', 'desk.js');

interface DeskApi {
  escapeHtml(v: unknown): string;
  stripInvisible(v: unknown): string;
  clamp(v: unknown, max: number): string;
  renderRail(state: unknown): string;
  renderPeerRow(peer: unknown): string;
  renderIdentity(identity: unknown): string;
  renderChallenge(challenge: unknown): string;
  renderGrantStep(peerId: unknown, verbs?: unknown): string;
  renderInvite(invite: unknown): string;
}

let desk: DeskApi;

beforeAll(() => {
  // Execute the shipped file in a module-like sandbox. `window`/`document` are
  // absent, so it takes the export branch and never touches the DOM.
  const source = fs.readFileSync(DESK_JS, 'utf8');
  const module = { exports: {} as DeskApi };
  new Function('module', 'exports', source)(module, module.exports);
  desk = module.exports;
});

/** Everything a hostile peer might put in a string field. */
const HOSTILE: Array<[string, string]> = [
  ['script tag', '</script><script>alert(1)</script>'],
  ['img onerror', '<img src=x onerror="alert(1)">'],
  ['attribute break out', '" onmouseover="alert(1)'],
  ['single-quote break out', "' onmouseover='alert(1)"],
  ['backtick', '`${alert(1)}`'],
  ['closing tag', '</li></ul><div class="desk-peer-badge">verified</div>'],
  ['entity double-encode', '&lt;script&gt;'],
  ['bidi override', 'alice\u202Eevil'],
  ['zero width', 'ali\u200Bce'],
  ['NUL', 'ali\u0000ce'],
  ['newline', 'alice\nBob'],
  ['forged badge', '<span class="desk-badge-warn">new key — unverified</span>'],
];

describe('the module loads and exports the real functions', () => {
  it('exports every render function', () => {
    for (const fn of [
      'escapeHtml', 'stripInvisible', 'clamp',
      'renderRail', 'renderPeerRow', 'renderIdentity',
      'renderChallenge', 'renderGrantStep', 'renderInvite',
    ]) {
      expect(typeof (desk as unknown as Record<string, unknown>)[fn], fn).toBe('function');
    }
  });

  it('the shipped file contains no literal control or bidi characters', () => {
    // A literal NUL makes git treat the file as binary, which silently removes
    // it from code review; a literal bidi override reorders the source for the
    // next reader, which is the very attack under test.
    const raw = fs.readFileSync(DESK_JS);
    expect(raw.includes(0x00), 'no NUL bytes').toBe(false);
    const text = raw.toString('utf8');
    expect(/[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/.test(text), 'no invisibles').toBe(false);
  });
});

describe('escapeHtml', () => {
  it('neutralises every HTML-significant character', () => {
    expect(desk.escapeHtml('<>&"\'`')).toBe('&lt;&gt;&amp;&quot;&#39;&#96;');
  });

  it('escapes the ampersand FIRST, so entities are not double-decoded', () => {
    // If & were escaped last, '&lt;' would render as '<'.
    expect(desk.escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('handles null, undefined and non-strings without throwing', () => {
    expect(desk.escapeHtml(null)).toBe('');
    expect(desk.escapeHtml(undefined)).toBe('');
    expect(desk.escapeHtml(42)).toBe('42');
    expect(desk.escapeHtml({})).toBe('[object Object]');
  });
});

describe('stripInvisible', () => {
  it('removes bidi overrides, zero-width and control characters', () => {
    expect(desk.stripInvisible('a\u202Eb')).toBe('ab');
    expect(desk.stripInvisible('a\u200Bb')).toBe('ab');
    expect(desk.stripInvisible('a\u0000b')).toBe('ab');
    expect(desk.stripInvisible('a\u2066b\u2069c')).toBe('abc');
    expect(desk.stripInvisible('a\uFEFFb')).toBe('ab');
  });

  it('leaves ordinary text, accents and emoji alone', () => {
    expect(desk.stripInvisible('José — billing-svc 🎉')).toBe('José — billing-svc 🎉');
  });
});

describe('clamp', () => {
  it('bounds a long string, so a peer cannot break the layout', () => {
    const out = desk.clamp('z'.repeat(10_000), 32);
    expect(out.length).toBeLessThanOrEqual(33); // 32 + ellipsis
  });

  it('strips invisibles before measuring, so padding cannot smuggle length', () => {
    expect(desk.clamp('\u200B'.repeat(100) + 'ok', 32)).toBe('ok');
  });
});

// ---------------------------------------------------------------------------

/**
 * Counts the markup a render produced.
 *
 * Asserting `not.toContain('onerror=')` is the obvious test and it is WRONG:
 * escaping turns `<img src=x onerror="…">` into `&lt;img src=x onerror=&quot;…`,
 * so that substring legitimately survives — as inert text. The property that
 * actually matters is that the payload created no new TAG, so the tag count for
 * a hostile input must equal the tag count for a benign one.
 */
function tagCount(html: string): number {
  return (html.match(/</g) || []).length;
}

describe('renderPeerRow — every peer-supplied field is escaped', () => {
  const benign = { peerId: 'p_x', alias: 'alice', trustDomain: 'acme', verbs: ['status'] };
  const baseline = () => tagCount(desk.renderPeerRow(benign));

  for (const [label, payload] of HOSTILE) {
    it(`creates no markup from ${label} in the alias`, () => {
      const html = desk.renderPeerRow({ ...benign, alias: payload });
      expect(tagCount(html), 'no tag was opened by the payload').toBe(baseline());
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('<span class="desk-peer-badge">verified');
    });

    it(`creates no markup from ${label} in the trust domain`, () => {
      const html = desk.renderPeerRow({ ...benign, trustDomain: payload });
      expect(tagCount(html)).toBe(baseline());
      expect(html).not.toContain('<script');
    });

    it(`cannot break out of the peerId attribute with ${label}`, () => {
      const html = desk.renderPeerRow({ ...benign, peerId: payload });
      expect(tagCount(html)).toBe(baseline());
      // No attribute may follow the quoted peerId inside the same tag.
      expect(html).not.toMatch(/data-desk-peer="[^"]*"\s+on\w+=/);
    });

    it(`creates no markup from ${label} in a verb name`, () => {
      const html = desk.renderPeerRow({ ...benign, verbs: [payload] });
      expect(tagCount(html)).toBe(baseline());
      expect(html).not.toContain('<script');
    });
  }

  it('cannot forge a verified-looking badge', () => {
    const html = desk.renderPeerRow({
      peerId: 'p_x',
      alias: '</span><span class="desk-peer-badge">verified</span><span>',
      trustDomain: 'acme', verbs: [],
    });
    // Exactly the badges the renderer itself decided on — here, none.
    expect((html.match(/class="desk-peer-badge/g) || []).length).toBe(0);
  });

  it('renders a rotated key as unverified, never as a continuation', () => {
    const html = desk.renderPeerRow({
      peerId: 'p_x', alias: 'alice', trustDomain: 'acme', verbs: [], rotatedFrom: 'p_old',
    });
    expect(html).toContain('unverified');
    expect(html).toContain('desk-peer-unverified');
  });

  it('keeps a revoked row visible and marked, and drops its Revoke button', () => {
    const html = desk.renderPeerRow({
      peerId: 'p_x', alias: 'alice', trustDomain: 'acme', verbs: [], revoked: true,
    });
    expect(html).toContain('desk-peer-revoked');
    expect(html).toContain('revoked');
    expect(html).not.toContain('data-desk-action="revoke"');
  });

  it('survives a malformed peer without throwing', () => {
    for (const bad of [null, undefined, 42, 'peer', []]) {
      expect(() => desk.renderPeerRow(bad)).not.toThrow();
    }
  });
});

describe('renderRail', () => {
  it('renders nothing at all when the feature is off', () => {
    expect(desk.renderRail({ enabled: false, peers: [] })).toBe('');
    expect(desk.renderRail(null)).toBe('');
  });

  it('collapses to one line with an Invite affordance when empty', () => {
    const html = desk.renderRail({ enabled: true, peers: [] });
    expect(html).toContain('no teammates yet');
    expect(html).toContain('data-desk-action="invite"');
    expect(html).not.toContain('<ul');
  });

  it('escapes hostile peers in the full roster too', () => {
    const clean = desk.renderRail({
      enabled: true,
      peers: [{ peerId: 'p_1', alias: 'alice', trustDomain: 'a', verbs: [] }],
      identity: { peerId: 'p_me' },
    });
    const hostile = desk.renderRail({
      enabled: true,
      peers: [{ peerId: 'p_1', alias: '<img src=x onerror=alert(1)>', trustDomain: 'a', verbs: [] }],
      identity: { peerId: 'p_me' },
    });
    expect((hostile.match(/</g) || []).length).toBe((clean.match(/</g) || []).length);
    expect(hostile).not.toContain('<img');
  });

  it('renders no image, icon or remote resource from peer data (I37)', () => {
    const html = desk.renderRail({
      enabled: true,
      peers: [{ peerId: 'p_1', alias: 'alice', trustDomain: 'https://evil.example/x.png', verbs: [] }],
      identity: { peerId: 'p_me' },
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('background-image');
    expect(html).not.toContain('url(');
    expect(html).not.toContain('src=');
  });
});

describe('renderChallenge', () => {
  const challenge = {
    sessionId: 's1',
    peerId: 'p_x',
    groups: ['11111', '22222', '33333', '44444', '55555', '66666',
             '77777', '88888', '99999', '00000', '12121', '34343'],
    demanded: [3, 7, 12],
    attemptsLeft: 3,
  };

  it('highlights exactly the demanded groups', () => {
    const html = desk.renderChallenge(challenge);
    expect((html.match(/desk-sn-demanded/g) || []).length).toBe(3);
  });

  it('renders one input per demanded group', () => {
    const html = desk.renderChallenge(challenge);
    expect((html.match(/desk-answer-input/g) || []).length).toBe(3);
    for (const n of challenge.demanded) {
      expect(html).toContain(`data-desk-group="${n}"`);
    }
  });

  it('names the FAILURE, not the action', () => {
    const html = desk.renderChallenge(challenge);
    expect(html.toLowerCase()).toContain('intercepting');
    expect(html.toLowerCase()).toContain('different channel');
  });

  it('says pairing is not complete until the other side has compared too', () => {
    expect(desk.renderChallenge(challenge).toLowerCase()).toContain('not complete until');
  });

  it('offers no skip-verification affordance', () => {
    const html = desk.renderChallenge(challenge).toLowerCase();
    expect(html).not.toContain('skip');
    expect(html).not.toContain('later');
    expect(html).not.toContain('trust anyway');
  });

  it('puts Cancel before Verify in the DOM — the easy path comes first', () => {
    const html = desk.renderChallenge(challenge);
    expect(html.indexOf('pair-cancel')).toBeLessThan(html.indexOf('pair-verify'));
  });

  it('escapes hostile group content rather than trusting its own state', () => {
    const html = desk.renderChallenge({
      ...challenge,
      groups: ['<script>x</script>', ...challenge.groups.slice(1)],
    });
    expect(html).not.toContain('<script');
  });

  it('coerces the demanded indices to numbers, so they cannot inject', () => {
    const html = desk.renderChallenge({ ...challenge, demanded: ['3" onload="alert(1)'] as unknown as number[] });
    expect(html).not.toContain('onload=');
  });

  it('survives a malformed challenge', () => {
    for (const bad of [null, undefined, {}, { groups: 'nope', demanded: 3 }]) {
      expect(() => desk.renderChallenge(bad)).not.toThrow();
    }
  });
});

describe('renderGrantStep', () => {
  it('defaults the saved status and locate permissions ON', () => {
    const html = desk.renderGrantStep('p_x');
    const checked = (s: string) => new RegExp(`data-desk-verb="${s}" checked`).test(html.replace(/"\s+checked/g, '" checked'));
    expect(checked('status')).toBe(true);
    expect(checked('locate')).toBe(true);
    expect(checked('consult')).toBe(false);
    expect(checked('review')).toBe(false);
  });

  it('omits unsupported grants even if previous state selected them', () => {
    const html = desk.renderGrantStep('p_x', ['status', 'consult', 'review']).toLowerCase();
    expect(html).not.toContain('data-desk-verb="consult"');
    expect(html).not.toContain('data-desk-verb="review"');
    expect(html).toContain('status works through the desk local status commands on this computer');
    expect(html).toContain('locate permissions are saved for future use');
    expect(html).toContain('cross-machine requests, consultation, and review are not available');
  });

  it('says what status and locate do NOT expose', () => {
    expect(desk.renderGrantStep('p_x').toLowerCase()).toContain('no file contents');
  });

  it('escapes a hostile peerId in the action attribute', () => {
    const html = desk.renderGrantStep('" onclick="alert(1)');
    expect(html).not.toContain('onclick="alert(1)"');
  });
});

describe('renderInvite', () => {
  it('says the link is not a password', () => {
    const html = desk.renderInvite({ url: 'desk://pair?x=1', expiresLabel: '9:47', expiresInMs: 587_000 });
    expect(html.toLowerCase()).toContain('not a password');
    expect(html.toLowerCase()).toContain('comparing the safety number');
  });

  it('marks an expired invite instead of offering it', () => {
    const html = desk.renderInvite({ url: 'desk://pair?x=1', expiresLabel: '0:00', expiresInMs: 0 });
    expect(html).toContain('desk-invite-expired');
    expect(html).toContain('Expired');
  });

  it('escapes a hostile url', () => {
    const html = desk.renderInvite({ url: '"><script>alert(1)</script>', expiresLabel: 'x', expiresInMs: 1 });
    expect(html).not.toContain('<script');
  });
});
