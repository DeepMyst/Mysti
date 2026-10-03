/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * The SINGLE trust boundary for visual testing.
 *
 * Every visual-test run — whether a human clicked Run in the dashboard or the
 * coordinator emitted a `<look:NONCE>` tag — resolves its configuration here and
 * nowhere else. Before this module each entry point hand-rolled its own
 * VisualTestConfig, which is how the model-triggered path came to hardcode the
 * browser/viewport and ignore every `mysti.visualTest.*` setting the user had set.
 *
 * The rule the whole design rests on: a MODEL may say WHAT to look at (a path, a
 * selector, a capture mode) but never WHERE (scheme/host/port) and never HOW the
 * server is started (the `spawn(shell:true)` chokepoint in DevServerManager).
 * A gate you never have to reach is stronger than a gate you must not forget —
 * the RCE fixed in 87960fd existed because the model could name a command at all.
 *
 * Pure: no `vscode` import, so it is directly unit-testable.
 */

import type { VisualTestConfig } from '../types';
import {
  VISUAL_DEFAULT_ALLOWED_ORIGINS,
  VISUAL_MAX_PATH_LENGTH,
  VISUAL_MAX_SELECTOR_LENGTH,
  VISUAL_MAX_FOCUS_LENGTH
} from '../constants';

/** Who is asking. `model` is the strictly-lower-authority origin. */
export type VisualRequester = 'user' | 'model';

/**
 * How much the requester may touch the page.
 * `off`  — capture only.
 * `safe` — click/type/hover/select/scroll + SAME-ORIGIN navigate.
 * `full` — everything `safe` allows; reserved for the human dashboard path.
 */
export type InteractionPolicy = 'off' | 'safe' | 'full';

/** Provenance of the dev-server command — the approval UX keys off this. */
export type DevCommandSource = 'none' | 'already-running' | 'settings' | 'package-json' | 'model';

/** What a caller asks for. Fields the model is not allowed to set are dropped, not honoured. */
export interface VisualLookRequest {
  requester: VisualRequester;
  /** Path + query relative to the app root, e.g. `/settings?tab=1`. The model-safe way to navigate. */
  path?: string;
  /** Absolute URL. IGNORED unless `requester === 'user'`. */
  url?: string;
  /** Dev-server command. IGNORED for a model unless `allowModelDevServerCommand` is on. */
  devServerCommand?: string;
  selector?: string;
  mode?: VisualTestConfig['screenshotMode'];
  /** CSS selector to await before capturing. */
  waitFor?: string;
  reload?: boolean;
  /** One line of intent, echoed into the observation header. Steers only the caller's own reasoning. */
  focus?: string;
  /** Requested interaction level. Clamped DOWN against policy; never raised. */
  interactions?: InteractionPolicy;
}

/** Everything the resolver needs from the host, injected so the module stays pure. */
export interface VisualPolicyDeps {
  /** `mysti.visualTest.enabled` — the user's master switch. */
  enabled: boolean;
  /** `mysti.mysti.visualTools === 'on'` — the AGENT capability (machine-scoped, ships off). */
  agentToolsEnabled: boolean;
  workspaceTrusted: boolean;
  workspaceRoot?: string;
  /** `mysti.visualTest.allowedOrigins` (machine-scoped). */
  allowedOrigins?: string[];
  /** `mysti.visualTest.allowModelDevServerCommand` (machine-scoped, default false). */
  allowModelDevServerCommand: boolean;
  /** `mysti.visualTest.agentInteractions` — the ceiling for a model. */
  agentInteractions: 'off' | 'safe';
  /** `mysti.visualTest.interactions` — the ceiling for a human. */
  userInteractions: InteractionPolicy;
  settingsUrl: string;
  settingsDevCommand: string;
  browser: VisualTestConfig['browser'];
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  maxIterations: number;
  /** Base URL of a live warm session. When present it PINS the origin — a model cannot move it. */
  sessionBaseUrl?: string;
  /** True when a dev server is already tracked for this panel (user-managed or session-owned). */
  devServerRunning?: boolean;
  /** `DevServerManager.detectDevCommand` — injected so the resolver stays free of `fs`. */
  detectDevCommand?: (workspaceRoot: string) => string | null;
  /** `ProjectContextManager` framework hint, used only to guess a default port. */
  framework?: string | null;
}

export interface VisualResolution {
  config: VisualTestConfig;
  /** The origins the browser is permitted to reach, enforced again at the network layer. */
  allowedOrigins: string[];
  devCommand?: string;
  devCommandSource: DevCommandSource;
  interactionPolicy: InteractionPolicy;
  /**
   * Requested-but-refused items, echoed back to the model. A refusal it cannot
   * see is a refusal it retries forever.
   */
  denials: string[];
}

export type VisualPolicyResult = { blocked: string } | VisualResolution;

export function isBlocked(r: VisualPolicyResult): r is { blocked: string } {
  return typeof (r as { blocked?: unknown }).blocked === 'string';
}

/**
 * Hosts that are never reachable, even if a user lists them in `allowedOrigins`.
 * Cloud instance-metadata endpoints hand out credentials to anything that can
 * issue a plain GET from inside the host — and a screenshot of the response
 * would go straight back to the model.
 */
const FORBIDDEN_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
  '[fd00:ec2::254]',
  'fd00:ec2::254',
]);

/** Link-local IPv4 (169.254.0.0/16) — the metadata range in every cloud. */
function isLinkLocal(hostname: string): boolean {
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * Is `url` inside the allowlist? FAILS CLOSED on anything unparseable, mirroring
 * `isDeepMystHost`.
 *
 * Matching is on scheme + exact hostname (+ port when the allowlist entry pins
 * one). Exact, because a suffix compare lets `http://localhost.evil.com` through
 * a `localhost` rule — the classic way an allowlist becomes decoration.
 */
export function isAllowedOrigin(url: string, allowed: string[] = VISUAL_DEFAULT_ALLOWED_ORIGINS): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') { return false; }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (FORBIDDEN_HOSTS.has(host) || FORBIDDEN_HOSTS.has(u.hostname.toLowerCase()) || isLinkLocal(host)) {
    return false;
  }

  for (const entry of allowed) {
    let a: URL;
    try {
      a = new URL(entry);
    } catch {
      continue;
    }
    if (a.protocol !== u.protocol) { continue; }
    if (a.hostname.toLowerCase() !== u.hostname.toLowerCase()) { continue; }
    // An allowlist entry with an explicit port pins that port; without one, any
    // port on that host is fine (dev servers move ports constantly).
    if (a.port && a.port !== u.port) { continue; }
    return true;
  }
  return false;
}

/**
 * Validate a model-supplied PATH. Returns the normalized path, or null.
 *
 * This is the model's only navigation primitive, so it must not be able to smuggle
 * an origin through it: no scheme, no protocol-relative `//host`, no backslashes
 * (Windows/browser normalization differences), no CR/LF (header/URL splitting).
 */
export function validatePath(p: string): string | null {
  if (typeof p !== 'string') { return null; }
  const s = p.trim();
  if (!s) { return null; }
  if (s.length > VISUAL_MAX_PATH_LENGTH) { return null; }
  if (/[\r\n\t\\]/.test(s)) { return null; }
  // Reject anything carrying a scheme (`http:`, `file:`, `javascript:`, `data:`).
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) { return null; }
  if (!s.startsWith('/')) { return null; }
  // `//host/x` is protocol-relative — a full origin swap in disguise.
  if (s.startsWith('//')) { return null; }
  return s;
}

/** Clamp a free-text field to a sane length; returns undefined for empty/None. */
function clampText(v: string | undefined, max: number): string | undefined {
  if (typeof v !== 'string') { return undefined; }
  const s = v.trim();
  if (!s) { return undefined; }
  return s.length > max ? s.slice(0, max) : s;
}

const POLICY_RANK: Record<InteractionPolicy, number> = { off: 0, safe: 1, full: 2 };

/** Clamp DOWNWARD only — a request can lower its own authority but never raise it. */
function clampPolicy(requested: InteractionPolicy | undefined, ceiling: InteractionPolicy): InteractionPolicy {
  if (!requested) { return ceiling; }
  return POLICY_RANK[requested] < POLICY_RANK[ceiling] ? requested : ceiling;
}

/** Default dev-server port by framework, so the first `look` lands without guessing. */
export function inferPortForFramework(framework: string | null | undefined): number | null {
  if (!framework) { return null; }
  const f = framework.toLowerCase();
  if (f.includes('vite')) { return 5173; }
  if (f.includes('angular')) { return 4200; }
  if (f.includes('svelte')) { return 5173; }
  if (f.includes('astro')) { return 4321; }
  if (f.includes('next') || f.includes('nuxt') || f.includes('react') || f.includes('remix')) { return 3000; }
  if (f.includes('vue')) { return 5173; }
  return null;
}

/** Join an origin and a path without doubling or dropping the separator. */
function joinUrl(base: string, path: string): string {
  try {
    return new URL(path, base).toString();
  } catch {
    return base;
  }
}

/** Extract the origin (scheme://host:port) of a URL, or null if unparseable. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve a visual-test request into a concrete, policy-clamped configuration.
 *
 * Precedence: live session > request (only fields this requester may set) >
 * `mysti.visualTest.*` settings > framework inference > defaults.
 */
export function resolveVisualLook(req: VisualLookRequest, deps: VisualPolicyDeps): VisualPolicyResult {
  const denials: string[] = [];
  const isModel = req.requester === 'model';

  // ── Hard blocks. Return a reason, never a partial config. ──
  if (!deps.enabled) {
    return { blocked: 'Visual testing is disabled (mysti.visualTest.enabled is false).' };
  }
  if (isModel && !deps.agentToolsEnabled) {
    return { blocked: 'Agent-driven visual testing is off. The user can enable it with the machine-scoped setting "mysti.mysti.visualTools".' };
  }
  if (isModel && !deps.workspaceTrusted) {
    return { blocked: 'This workspace is not trusted, so agent-driven visual testing is unavailable.' };
  }
  if (!deps.workspaceRoot) {
    return { blocked: 'No workspace folder is open, so there is no app to run.' };
  }

  const allowedOrigins = (deps.allowedOrigins && deps.allowedOrigins.length > 0)
    ? deps.allowedOrigins
    : VISUAL_DEFAULT_ALLOWED_ORIGINS;

  // ── Resolve the ORIGIN. The model has no say here, ever. ──
  let baseOrigin: string | null = null;
  if (deps.sessionBaseUrl) {
    // A warm session pins the origin for its whole lifetime.
    baseOrigin = originOf(deps.sessionBaseUrl);
  }
  if (!baseOrigin && req.url) {
    if (isModel) {
      denials.push('The "url" you supplied was ignored — the address comes from the user\'s settings, not from you. Use "path" to choose a page.');
    } else if (isAllowedOrigin(req.url, allowedOrigins)) {
      baseOrigin = originOf(req.url);
    } else {
      return { blocked: `The URL "${req.url}" is outside the allowed origins (${allowedOrigins.join(', ')}).` };
    }
  }
  if (!baseOrigin && deps.settingsUrl) {
    baseOrigin = originOf(deps.settingsUrl);
  }
  if (!baseOrigin) {
    const port = inferPortForFramework(deps.framework);
    baseOrigin = `http://localhost:${port ?? 3000}`;
  }
  if (!isAllowedOrigin(baseOrigin, allowedOrigins)) {
    return { blocked: `The configured URL "${baseOrigin}" is outside the allowed origins (${allowedOrigins.join(', ')}). Adjust mysti.visualTest.url or mysti.visualTest.allowedOrigins.` };
  }

  // ── Resolve the PATH (the model's only navigation lever). ──
  let url = baseOrigin;
  if (req.path) {
    const safePath = validatePath(req.path);
    if (safePath) {
      url = joinUrl(baseOrigin, safePath);
    } else {
      denials.push(`The path "${String(req.path).slice(0, 80)}" was rejected — give a plain app-root-relative path like "/settings".`);
    }
  } else if (!req.path && req.url && !isModel) {
    // A user-supplied absolute URL keeps its own path.
    url = req.url;
  }
  // Defence in depth: the joined URL must still be inside the allowlist.
  if (!isAllowedOrigin(url, allowedOrigins)) {
    return { blocked: `The resolved URL "${url}" is outside the allowed origins.` };
  }

  // ── Resolve the DEV SERVER COMMAND. This is the shell chokepoint. ──
  let devCommand: string | undefined;
  let devCommandSource: DevCommandSource = 'none';
  if (deps.devServerRunning) {
    devCommandSource = 'already-running';
  } else {
    const modelCommand = clampText(req.devServerCommand, 400);
    if (isModel && modelCommand && !deps.allowModelDevServerCommand) {
      // The default. Refuse it outright rather than gating it — a command the
      // model cannot name is a command no dialog can be talked into approving.
      denials.push('I will not run a dev-server command that you supplied. Ask the user to set "mysti.visualTest.devServerCommand", or to start their dev server themselves.');
    } else if (modelCommand && (!isModel || deps.allowModelDevServerCommand)) {
      devCommand = modelCommand;
      devCommandSource = isModel ? 'model' : 'settings';
    }
    if (!devCommand) {
      const fromSettings = clampText(deps.settingsDevCommand, 400);
      if (fromSettings) {
        devCommand = fromSettings;
        devCommandSource = 'settings';
      } else if (deps.detectDevCommand && deps.workspaceRoot) {
        const detected = deps.detectDevCommand(deps.workspaceRoot);
        if (detected) {
          devCommand = detected;
          devCommandSource = 'package-json';
        }
      }
    }
  }

  // ── Resolve the INTERACTION policy (downward-clamped). ──
  const ceiling: InteractionPolicy = isModel ? deps.agentInteractions : deps.userInteractions;
  const interactionPolicy = clampPolicy(req.interactions, ceiling);
  if (req.interactions && POLICY_RANK[req.interactions] > POLICY_RANK[ceiling]) {
    denials.push(`Interaction level "${req.interactions}" was lowered to "${interactionPolicy}" by the user's settings.`);
  }

  // ── Capture shape. Only the requester's own view is steered here. ──
  const selector = clampText(req.selector, VISUAL_MAX_SELECTOR_LENGTH);
  const requestedMode = req.mode === 'full-page' || req.mode === 'element' || req.mode === 'viewport'
    ? req.mode
    : undefined;
  // `element` without a selector is meaningless — fall back rather than throw.
  const screenshotMode: VisualTestConfig['screenshotMode'] =
    requestedMode === 'element' && !selector ? 'viewport' : (requestedMode ?? 'viewport');

  const config: VisualTestConfig = {
    url,
    devServerCommand: devCommand,
    requirements: clampText(req.focus, VISUAL_MAX_FOCUS_LENGTH) || '',
    maxIterations: deps.maxIterations,
    screenshotMode,
    elementSelector: selector,
    // Browser/headless/viewport are the USER's, never the caller's.
    browser: deps.browser,
    headless: isModel ? true : deps.headless,
    viewportWidth: deps.viewportWidth,
    viewportHeight: deps.viewportHeight,
    waitForSelector: clampText(req.waitFor, VISUAL_MAX_SELECTOR_LENGTH),
    interactionsEnabled: interactionPolicy !== 'off',
  };

  return { config, allowedOrigins, devCommand, devCommandSource, interactionPolicy, denials };
}
