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
 */

import { classifyToolAction, shouldGateToolUse } from '../utils/permissionClassifier';
import { SUBAGENT_TIMEOUT_MS, SUBAGENT_MAX_RETRIES, SUBAGENT_QUESTION_TIMEOUT_MS } from '../constants';
import type { NativeApprovalHandler, NativeApprovalRequest } from '../providers/base/IProvider';
import type {
  ContextItem,
  Settings,
  Conversation,
  StreamChunk,
  CollaboratorSpec,
  CollaboratorChunk,
  CollaboratorFailure,
  CollaboratorDispatchOptions,
} from '../types';

/**
 * Default max collaborators dispatched at once. Overridable per-run via
 * CollaboratorDispatchOptions.maxConcurrent (which itself defaults from the
 * `mysti.collab.maxConcurrent` setting, read by the caller).
 */
export const COLLAB_DEFAULT_MAX_CONCURRENT = 3;

/**
 * The narrow slice of ProviderManager the pool depends on. Declaring it as an
 * interface (rather than importing the concrete class) keeps the pool unit-
 * testable against the hand-written MockProviderManager and decoupled from the
 * 500-line manager.
 */
export interface PoolProviderManager {
  sendMessageToProvider(
    providerId: string,
    content: string,
    context: ContextItem[],
    settings: Settings,
    conversation: Conversation | null,
    persona?: unknown,
    panelId?: string
  ): AsyncGenerator<StreamChunk>;
  cancelRequest(panelId: string): void;
  disposePersistentProcessForProvider?(providerId: string, panelId: string): void;
  suspendRequest(panelId: string): boolean;
  resumeRequest(panelId: string): boolean;
  getProviderStatus(providerId: string): Promise<{
    found: boolean;
    authenticated: boolean;
    path: string;
    installCommand?: string;
  } | null>;
  getProviderDefaultModel(providerId: string): string;
  getProviderInstance?(providerId: string): { capabilities: { supportsNativeApproval?: boolean; toolExecution?: 'native' | 'proposal-only' | 'none' } } | undefined;
  setNativeApprovalHandlerForPanel?(panelId: string, handler: NativeApprovalHandler): { dispose(): void };
}

interface NativeChildApprovalScope {
  denied: { toolCall: NonNullable<StreamChunk['toolCall']>; reason: string }[];
  cancelled: boolean;
  dispose(): void;
}

/**
 * CollaboratorPool (Plan 14 Phase 0) — one shared, bounded dispatch primitive
 * for running N agents as collaborators/advisors/critics/reviewers.
 *
 * It owns the reliability contract in ONE place (previously duplicated across
 * MentionRouter and BrainstormManager):
 *   - a real concurrency cap (unlike BrainstormManager._interleaveGenerators,
 *     which eagerly starts every iterator);
 *   - per-collaborator timeout + transport retry;
 *   - an availability pre-check that turns an uninstalled/unauthenticated CLI
 *     into a skip-with-hint, never a hang or cryptic stream error;
 *   - a structured CollaboratorFailure taxonomy so one failure never sinks a run;
 *   - UUID-scoped derived panels (`${panelId}-collab-${runId}-${collaboratorId}`)
 *     so concurrent/sequential runs never collide in the provider's panel maps;
 *   - completion by transport signal (the provider `done` chunk), never text matching;
 *   - a real per-child permission gate: for `read-only` collaborators any non-
 *     file-read tool is hard-denied locally; for `gated-write` the pool SIGSTOPs
 *     the child, awaits the caller's gate, and resumes/cancels the CHILD's own
 *     panel (fixing the legacy MentionRouter gate, which cancelled the parent);
 *   - cancel fan-out to every derived child panel (Stop tears down the whole run).
 */
export class CollaboratorPool {
  private _providerManager: PoolProviderManager;
  /** runId -> set of live child panel ids, for cancel fan-out. */
  private _activeChildPanels: Map<string, Set<string>> = new Map();
  /**
   * runId -> childPanelId -> agentId for EVERY child ever dispatched in the run
   * (not pruned on completion, unlike _activeChildPanels). Lets disposeRun()
   * reclaim persistent child processes at end-of-run — the P0.2e stable-panel
   * design keeps them ALIVE across delegations for --resume continuity, so
   * nothing else kills them (review [13]).
   */
  private _runChildProviders: Map<string, Map<string, string>> = new Map();
  /**
   * Runs already reclaimed by disposeRun (Plan 18). A child parked at an
   * internal await (gate card, relayed question) survives cancelRun; when it
   * resumes it must NOT re-register into the maps disposeRun just cleaned —
   * that resurrects the leak — nor spawn follow-up children for a dead run.
   * Bounded FIFO (one UUID per run).
   */
  private _closedRuns: Set<string> = new Set();
  private static readonly CLOSED_RUNS_CAP = 256;
  /** Child panels where a gated WRITE was approved this run — a later crash/
   * timeout on such an attempt must NOT retry (double-apply risk). Pruned in
   * disposeRun. */
  private _approvedWriteChildren: Set<string> = new Set();

  constructor(providerManager: PoolProviderManager) {
    this._providerManager = providerManager;
  }

  /**
   * Dispatch every spec, at most `maxConcurrent` at a time, yielding chunks as
   * they arrive from any running collaborator. Independent runs are isolated by
   * `options.runId`.
   */
  public async *dispatch(
    specs: CollaboratorSpec[],
    options: CollaboratorDispatchOptions
  ): AsyncGenerator<CollaboratorChunk> {
    if (specs.length === 0) {
      return;
    }
    const cap = Math.max(1, options.maxConcurrent ?? COLLAB_DEFAULT_MAX_CONCURRENT);
    this._activeChildPanels.set(options.runId, new Set());

    try {
      const thunks = specs.map(spec => () => this._runCollaborator(spec, options));
      yield* this._boundedMerge(thunks, cap);
    } finally {
      // Consumer break / normal completion: tear down any child still running.
      this.cancelRun(options.runId);
    }
  }

  /**
   * Cancel every live child of a run (fan-out). Safe to call repeatedly; also
   * invoked from dispatch's finally so a consumer `break` cleans up.
   */
  public cancelRun(runId: string): void {
    const panels = this._activeChildPanels.get(runId);
    if (!panels) {
      return;
    }
    for (const childPanelId of panels) {
      try {
        this._providerManager.cancelRequest(childPanelId);
      } catch (err) {
        console.warn(`[Mysti] CollaboratorPool: cancel failed for ${childPanelId}:`, err);
      }
    }
    this._activeChildPanels.delete(runId);
  }

  /**
   * Cancel ONE collaborator, leaving the rest of the run alive (Plan 29).
   *
   * A session runs several lanes at once and each needs its own Stop: with
   * three processes live, a single run-wide cancel is the only control, which
   * makes abandoning one slow lane cost you the two that were working. Matches
   * every panel derived for the collaborator, retries included, since a retry
   * runs under a `-retryN` suffix and cancelling only the base id orphans it.
   *
   * Returns the number of child panels cancelled (0 when the collaborator has
   * already landed, which is not an error).
   */
  public cancelCollaborator(runId: string, collaboratorId: string): number {
    const panels = this._activeChildPanels.get(runId);
    if (!panels) { return 0; }
    const base = `-collab-${runId}-${collaboratorId}`;
    let cancelled = 0;
    for (const childPanelId of [...panels]) {
      // Match retry and question-follow-up children without matching c10 for c1.
      const at = childPanelId.indexOf(base);
      if (at === -1) { continue; }
      const tail = childPanelId.slice(at + base.length);
      if (!/^(?:-retry\d+)?(?:-followup)?$/.test(tail)) { continue; }
      try {
        this._providerManager.cancelRequest(childPanelId);
        cancelled++;
      } catch (err) {
        console.warn(`[Mysti] CollaboratorPool: lane cancel failed for ${childPanelId}:`, err);
      }
      panels.delete(childPanelId);
    }
    return cancelled;
  }

  /**
   * End-of-run cleanup (review [13]): dispose EVERY delegation child's
   * persistent process for the run and evict its session, so within-run
   * continuity (P0.2e) doesn't leak a live CLI process per turn. Call AFTER the
   * agentic loop finishes (its finally), never between delegations.
   */
  public disposeRun(runId: string): void {
    // Tombstone FIRST: a child parked at a gate/question can resume after
    // this method returns — the guards in _recordRunChild/_dispatchWithRetry/
    // _relayQuestion check this set so a closed run can't repopulate the maps
    // or spawn new children (Plan 18 Stop race).
    this._closedRuns.add(runId);
    if (this._closedRuns.size > CollaboratorPool.CLOSED_RUNS_CAP) {
      const oldest = this._closedRuns.values().next().value;
      if (oldest !== undefined) { this._closedRuns.delete(oldest); }
    }
    this.cancelRun(runId); // kill anything still live first
    const children = this._runChildProviders.get(runId);
    if (!children) { return; }
    for (const [childPanelId, agentId] of children) {
      try {
        this._providerManager.disposePersistentProcessForProvider?.(agentId, childPanelId);
        this._providerManager.cancelRequest(childPanelId);
      } catch (err) {
        console.warn(`[Mysti] CollaboratorPool: disposeRun failed for ${childPanelId}:`, err);
      }
      this._approvedWriteChildren.delete(childPanelId);
    }
    this._runChildProviders.delete(runId);
  }

  // ===========================================================================
  // Bounded merge (the concurrency-capped fan-out primitive)
  // ===========================================================================

  /**
   * Merge N generator thunks, keeping at most `cap` active at once. A thunk's
   * generator body does not execute until its first `.next()`, so starting new
   * thunks only as active ones COMPLETE bounds the number of in-flight children.
   * No result is dropped: a re-armed iterator's promise is retained in `active`
   * until consumed (the same race-safety BrainstormManager relies on).
   */
  private async *_boundedMerge<T>(
    thunks: Array<() => AsyncGenerator<T>>,
    cap: number
  ): AsyncGenerator<T> {
    type Entry = { key: symbol; it: AsyncIterator<T>; promise: Promise<{ key: symbol; it: AsyncIterator<T>; result: IteratorResult<T> }> };
    const active = new Map<symbol, Entry>();
    const queue = [...thunks];

    const startNext = (): void => {
      const thunk = queue.shift();
      if (!thunk) {
        return;
      }
      const key = Symbol('collab');
      const it = thunk()[Symbol.asyncIterator]();
      const promise = it.next().then(result => ({ key, it, result }));
      active.set(key, { key, it, promise });
    };

    while (active.size < cap && queue.length > 0) {
      startNext();
    }

    try {
      while (active.size > 0) {
        const { key, it, result } = await Promise.race(
          Array.from(active.values()).map(e => e.promise)
        );
        if (result.done) {
          active.delete(key);
          startNext();
        } else {
          yield result.value;
          const promise = it.next().then(r => ({ key, it, result: r }));
          active.set(key, { key, it, promise });
        }
      }
    } finally {
      // Consumer break / cancel: propagate `.return()` to every child still in
      // flight. A child suspended at an internal `await` (availability probe,
      // gate, question relay) then performs a clean return on resumption
      // instead of spawning an uncancellable orphan process.
      for (const entry of active.values()) {
        try {
          void entry.it.return?.(undefined);
        } catch {
          /* best-effort teardown */
        }
      }
      // Queued-but-never-started thunks are just dropped (their generator
      // bodies never ran), so there is nothing to return for them.
      queue.length = 0;
    }
  }

  // ===========================================================================
  // Per-collaborator lifecycle
  // ===========================================================================

  private async *_runCollaborator(
    spec: CollaboratorSpec,
    options: CollaboratorDispatchOptions
  ): AsyncGenerator<CollaboratorChunk> {
    const base = {
      collaboratorId: spec.collaboratorId,
      agentId: spec.agentId,
      role: spec.role,
      label: spec.label,
    };

    yield { ...base, type: 'collab_started' };

    // --- Availability pre-check: never dispatch a missing/unauthed CLI ---
    let status: Awaited<ReturnType<PoolProviderManager['getProviderStatus']>> = null;
    try {
      status = await this._providerManager.getProviderStatus(spec.agentId);
    } catch (err) {
      console.warn(`[Mysti] CollaboratorPool: status probe failed for ${spec.agentId}:`, err);
    }
    if (status && !status.found) {
      yield {
        ...base,
        type: 'collab_skipped',
        failure: 'not-installed',
        hasError: true,
        hint: status.installCommand ? `Install with: ${status.installCommand}` : 'See provider documentation.',
      };
      return;
    }
    if (status && status.found && !status.authenticated) {
      yield {
        ...base,
        type: 'collab_skipped',
        failure: 'not-authenticated',
        hasError: true,
        hint: `${spec.label || spec.agentId} is installed but not authenticated. Sign in, then retry.`,
      };
      return;
    }

    // --- Dispatch with timeout + retry ---
    const { responseText, hasError, failure } = yield* this._dispatchWithRetry(spec, options, base);

    yield {
      ...base,
      type: 'collab_complete',
      responseText,
      hasError,
      failure,
    };
  }

  private async *_dispatchWithRetry(
    spec: CollaboratorSpec,
    options: CollaboratorDispatchOptions,
    base: Pick<CollaboratorChunk, 'collaboratorId' | 'agentId' | 'role' | 'label'>
  ): AsyncGenerator<CollaboratorChunk, { responseText: string; hasError: boolean; failure?: CollaboratorFailure }> {
    let attempt = 0;
    let lastFailure: CollaboratorFailure | undefined;

    while (attempt <= SUBAGENT_MAX_RETRIES) {
      if (attempt > 0) {
        const prevPanelId = this._childPanelId(options, spec, attempt - 1);
        this._forgetChild(options.runId, prevPanelId);
        this._providerManager.cancelRequest(prevPanelId);
        yield { ...base, type: 'collab_retry', retryCount: attempt };
      }

      // Plan 18: never (re)dispatch into a run disposeRun already reclaimed —
      // a child that was parked at a gate when Stop hit resumes here on the
      // 'crashed' retry path and would otherwise spawn a fresh child for a
      // dead run.
      if (this._closedRuns.has(options.runId)) {
        return { responseText: '', hasError: true, failure: 'cancelled' };
      }

      const childPanelId = this._childPanelId(options, spec, attempt);
      if (attempt === 0) {
        // W4 review: stable P0.2e collaboratorIds mean successive delegations
        // to the same agent REUSE these childPanelIds — the approved-write
        // flag is per-DISPATCH state, not per-run, or one approved write
        // would make every later delegation's transient failure terminal.
        // Clear every attempt variant (retry ids are reused too).
        for (let a = 0; a <= SUBAGENT_MAX_RETRIES; a++) {
          this._approvedWriteChildren.delete(this._childPanelId(options, spec, a));
        }
      }
      this._rememberChild(options.runId, childPanelId);
      // Record for end-of-run disposal (retained beyond completion).
      this._recordRunChild(options.runId, childPanelId, spec.agentId);

      const childSettings: Settings = {
        ...options.settings,
        provider: spec.agentId,
        model: spec.model ?? this._providerManager.getProviderDefaultModel(spec.agentId),
        // P2.3/P0.2b (Plan 17): an EXPLICIT spec.model is a routing decision that
        // must win over a per-provider `mysti.<provider>Model` custom-model config.
        // `model` above is defeated by that config in every provider's
        // `_getEffectiveModel` override; `routedModel` is checked FIRST there.
        // Only set it when a model was explicitly routed — undefined keeps the
        // child on its own normal precedence (config custom-model wins).
        ...(spec.model ? { routedModel: spec.model } : {}),
        // Plan 24: per-lane effort override (economy profile lowers fast-lane
        // effort). Undefined ⇒ inherit the parent's effort; providers without
        // effortLevels ignore it via clampEffort, and a stable per-(run,agent)
        // value avoids persistent-process respawn churn.
        ...(spec.effortLevel ? { effortLevel: spec.effortLevel } : {}),
        // Advisory collaborators run read-only; the pool hard-denies writes below
        // regardless, but this keeps the child's own gate/flags aligned.
        accessLevel: (spec.access === 'read-only' || spec.access === 'sealed')
          ? 'read-only'
          : options.settings.accessLevel,
        // P0.2d (Plan 17): a plan-mode PARENT must not silently produce
        // plan-only children — a delegated "implement X" would return a plan
        // instead of edits (claude: --permission-mode plan; gemini: --sandbox,
        // which also fails outright without a container runtime). 'default'
        // keeps the stream-level gate as the authority for the child's writes.
        mode: (options.settings.mode === 'quick-plan' || options.settings.mode === 'detailed-plan')
          ? 'default'
          : options.settings.mode,
      };

      const outcome = yield* this._streamOnce(spec, options, base, childPanelId, childSettings);
      this._forgetChild(options.runId, childPanelId);

      if (!outcome.hasError) {
        return outcome;
      }
      lastFailure = outcome.failure;
      // Denials and cancellations are terminal — retrying would re-trigger the
      // same forbidden action or fight a user cancel.
      if (outcome.failure === 'denied' || outcome.failure === 'cancelled') {
        return outcome;
      }
      // Plan 18 (1.3/M4b): so is any attempt where a gated write was already
      // APPROVED — re-running the prompt from scratch could apply the write
      // twice. Surface the failure instead.
      if (this._approvedWriteChildren.has(childPanelId)) {
        return outcome;
      }
      attempt++;
    }

    return { responseText: '', hasError: true, failure: lastFailure ?? 'crashed' };
  }

  /**
   * A single dispatch attempt: stream the provider, gate tool use, relay
   * questions, and enforce the timeout. Returns the accumulated text + outcome.
   */
  private async *_streamOnce(
    spec: CollaboratorSpec,
    options: CollaboratorDispatchOptions,
    base: Pick<CollaboratorChunk, 'collaboratorId' | 'agentId' | 'role' | 'label'>,
    childPanelId: string,
    childSettings: Settings
  ): AsyncGenerator<CollaboratorChunk, { responseText: string; hasError: boolean; failure?: CollaboratorFailure }> {
    let responseText = '';
    let hasError = false;
    let failure: CollaboratorFailure | undefined;
    let timedOut = false;
    let nativeApprovals: NativeChildApprovalScope | undefined;

    const timeoutMs = spec.timeoutMs ?? SUBAGENT_TIMEOUT_MS;
    const onTimeout = () => {
      timedOut = true;
      this._providerManager.cancelRequest(childPanelId);
    };

    try {
      nativeApprovals = this._registerNativeApprovals(spec, options, childPanelId);
      const stream = this._providerManager.sendMessageToProvider(
        spec.agentId,
        spec.prompt,
        this._collectContext(spec),
        childSettings,
        options.conversation ?? null,
        undefined,
        childPanelId
      );

      // Race each pull against the deadline so a provider that ignores cancel
      // still terminates the attempt (the legacy MentionRouter loop only checks
      // a flag at the top of each iteration and hangs on such a provider).
      for await (const chunk of this._withDeadline(stream, timeoutMs, onTimeout)) {
        if (nativeApprovals?.denied.length || nativeApprovals?.cancelled) { break; }
        if (chunk.type === 'text' && chunk.content) {
          responseText += chunk.content;
          yield { ...base, type: 'collab_text', content: chunk.content };
        } else if (chunk.type === 'thinking' && chunk.content) {
          yield { ...base, type: 'collab_thinking', content: chunk.content };
        } else if (chunk.type === 'tool_use' && chunk.toolCall) {
          // Native providers have already awaited the registered pre-execution
          // gate. Their subsequent tool notification must not ask a second time.
          const allowed = nativeApprovals ? true : yield* this._gateToolUse(spec, options, base, childPanelId, chunk.toolCall);
          if (!allowed) {
            hasError = true;
            failure = 'denied';
            break;
          }
          yield { ...base, type: 'collab_tool_use', toolCall: chunk.toolCall };
        } else if (chunk.type === 'tool_result' && chunk.toolCall) {
          yield { ...base, type: 'collab_tool_result', toolCall: chunk.toolCall };
        } else if (chunk.type === 'ask_user_question' && chunk.askUserQuestion) {
          nativeApprovals?.dispose();
          const followUp = yield* this._relayQuestion(spec, options, base, childPanelId, childSettings, chunk, responseText);
          responseText = followUp.responseText;
          if (followUp.hasError) {
            hasError = true;
            failure = followUp.failure;
          }
          // The question path spawns its own follow-up process and fully
          // handles this attempt.
          return { responseText, hasError, failure };
        } else if (chunk.type === 'auth_error') {
          hasError = true;
          failure = 'not-authenticated';
          yield { ...base, type: 'collab_error', failure, content: chunk.content || 'Authentication required', hasError: true };
          break;
        } else if (chunk.type === 'error') {
          hasError = true;
          failure = 'stream-error';
          yield { ...base, type: 'collab_error', failure, content: chunk.content, hasError: true };
          break;
        }
        // 'done' / 'session_active' / other transport chunks: completion is the
        // stream ending, not a keyword — just let the loop finish.
      }
    } catch (err) {
      hasError = true;
      failure = timedOut ? 'timeout' : 'crashed';
      yield { ...base, type: 'collab_error', failure, content: err instanceof Error ? err.message : 'Unknown error', hasError: true };
    } finally {
      nativeApprovals?.dispose();
    }

    if (nativeApprovals?.denied.length) {
      hasError = true;
      failure = 'denied';
      for (const denied of nativeApprovals.denied) {
        yield { ...base, type: 'collab_tool_denied', toolCall: denied.toolCall, content: denied.reason };
      }
      this._providerManager.cancelRequest(childPanelId);
    } else if (nativeApprovals?.cancelled && !timedOut) {
      hasError = true;
      failure = 'cancelled';
    }

    // The deadline wrapper returns (rather than throws) on timeout — surface it.
    if (timedOut && !hasError) {
      hasError = true;
      failure = 'timeout';
      yield { ...base, type: 'collab_error', failure, content: `Collaborator timed out after ${Math.round(timeoutMs / 1000)}s`, hasError: true };
    }

    if (!hasError && responseText.trim().length === 0) {
      hasError = true;
      failure = 'empty-response';
      yield { ...base, type: 'collab_error', failure, content: 'Collaborator returned no output', hasError: true };
    }

    return { responseText, hasError, failure };
  }

  /**
   * Wrap a provider stream so each pull races the remaining deadline. On timeout
   * it invokes `onTimeout` (which cancels the child) and returns — the caller
   * detects the timeout via its own flag. Timers are cleared per-chunk so a long
   * default deadline never leaks a timer per streamed token.
   */
  private async *_withDeadline(
    stream: AsyncGenerator<StreamChunk>,
    deadlineMs: number,
    onTimeout: () => void
  ): AsyncGenerator<StreamChunk> {
    const TIMEOUT = Symbol('timeout');
    const it = stream[Symbol.asyncIterator]();
    const deadline = Date.now() + deadlineMs;
    // Manual iteration means an early return here does NOT auto-propagate to the
    // provider generator, so its finally (attachment temp-file cleanup, process
    // teardown) would be skipped. The try/finally re-propagates .return() on
    // timeout, break, or the consumer cancelling this wrapper.
    let returned = false;

    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          onTimeout();
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutP = new Promise<typeof TIMEOUT>(resolve => {
          timer = setTimeout(() => resolve(TIMEOUT), remaining);
        });
        let raced: IteratorResult<StreamChunk> | typeof TIMEOUT;
        try {
          raced = await Promise.race([it.next(), timeoutP]);
        } finally {
          if (timer) {
            clearTimeout(timer);
          }
        }
        if (raced === TIMEOUT) {
          onTimeout();
          return;
        }
        if (raced.done) {
          returned = true; // provider generator already completed
          return;
        }
        yield raced.value;
      }
    } finally {
      if (!returned) {
        // Fire-and-forget: never AWAIT the return — a provider generator parked
        // on a stalled read (the whole reason this wrapper exists) would block
        // teardown forever. onTimeout()/cancelRequest already kills the process;
        // this just lets the generator's finally (attachment cleanup) run when
        // the process dies.
        try {
          Promise.resolve(it.return?.(undefined)).catch(() => { /* ignore */ });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Native requests already block the issuing backend; no process signals are needed. */
  private _registerNativeApprovals(
    spec: CollaboratorSpec,
    options: CollaboratorDispatchOptions,
    childPanelId: string,
  ): NativeChildApprovalScope | undefined {
    if (!this._providerManager.getProviderInstance?.(spec.agentId)?.capabilities.supportsNativeApproval) { return undefined; }
    const register = this._providerManager.setNativeApprovalHandlerForPanel;
    if (!register) { throw new Error(`Native approval routing is unavailable for ${spec.agentId}`); }
    let active = true;
    const scope: NativeChildApprovalScope = { denied: [], cancelled: false, dispose: () => {} };
    const deniedRequests = new Set<string>();
    const current = (request: NativeApprovalRequest) => active && !request.signal.aborted
      && !this._closedRuns.has(options.runId) && !!this._activeChildPanels.get(options.runId)?.has(childPanelId);
    const deny = (request: NativeApprovalRequest, reason: string) => {
      if (!deniedRequests.has(request.id)) {
        deniedRequests.add(request.id);
        scope.denied.push({ toolCall: request.toolCall, reason });
      }
      return false;
    };
    const handler: NativeApprovalHandler = async request => {
      if (scope.cancelled || !current(request)) { scope.cancelled = true; return 'cancelled'; }
      if (request.panelId !== childPanelId || request.providerId !== spec.agentId) { return false; }
      if (scope.denied.length) { return deny(request, 'Another tool request in this task was denied.'); }
      // A transport hard denial is never widened by the host's permission UI.
      if (request.defaultDecision === 'deny') { return deny(request, 'The provider denied this tool.'); }
      const policy = this._toolPolicy(spec, options, request.toolCall);
      if (policy.decision === 'deny') { return deny(request, policy.reason); }

      let approved: boolean | 'cancelled' = policy.decision === 'allow' && request.defaultDecision === 'allow';
      if (!approved) {
        approved = await this._awaitNativeGate(spec, options, request);
      }
      if (approved === 'cancelled' || scope.cancelled || !current(request)) { scope.cancelled = true; return 'cancelled'; }
      if (scope.denied.length) { return deny(request, 'Another tool request in this task was denied.'); }
      if (!approved) { return deny(request, 'Permission denied.'); }
      // Native approval is a real pre-execution decision. Once a non-read
      // action may have run, a later transport failure cannot retry the prompt.
      if (policy.mayHaveSideEffects) {
        this._approvedWriteChildren.add(childPanelId.replace(/-followup$/, ''));
      }
      return true;
    };
    handler.onDecision = (request, decision) => {
      if (decision === 'deny' && current(request) && request.panelId === childPanelId && request.providerId === spec.agentId) {
        deny(request, 'The provider denied this tool.');
      }
    };
    const registration = register.call(this._providerManager, childPanelId, handler);
    scope.dispose = () => {
      if (!active) { return; }
      active = false;
      registration.dispose();
    };
    return scope;
  }

  /**
   * One role policy for native requests and legacy notifications. Delegation
   * tools can run hidden writes despite classifying as reads. Sealed tasks have
   * off-machine prompts, so their web requests cannot use the research carve-out.
   */
  private _toolPolicy(
    spec: CollaboratorSpec,
    options: CollaboratorDispatchOptions,
    toolCall: NonNullable<StreamChunk['toolCall']>,
  ): { decision: 'allow' | 'ask'; mayHaveSideEffects: boolean } | { decision: 'deny'; reason: string } {
    const action = classifyToolAction(toolCall.name);
    const delegation = /^(task|agent|dispatch_agent|tool_search|toolsearch)$/i.test(toolCall.name);
    if (!delegation && action === 'file-read') { return { decision: 'allow', mayHaveSideEffects: false }; }
    if (spec.access === 'sealed') {
      return { decision: 'deny', reason: `Sealed role '${spec.role || 'sealed'}' may only read — ${toolCall.name} denied.` };
    }
    if (!delegation && action === 'web-request' && options.settings.accessLevel !== 'read-only'
      && !shouldGateToolUse(options.settings, toolCall.name)) {
      return { decision: 'allow', mayHaveSideEffects: true };
    }
    if (spec.access === 'read-only' && action !== 'web-request') {
      return { decision: 'deny', reason: `Advisory role '${spec.role || 'read-only'}' attempted a non-read tool (${toolCall.name}) — denied.` };
    }
    return { decision: 'ask', mayHaveSideEffects: true };
  }

  private _awaitNativeGate(
    spec: CollaboratorSpec,
    options: CollaboratorDispatchOptions,
    request: NativeApprovalRequest,
  ): Promise<boolean | 'cancelled'> {
    if (request.signal.aborted) { return Promise.resolve('cancelled'); }
    if (!options.onGate) { return Promise.resolve(false); }
    return new Promise(resolve => {
      let settled = false;
      const finish = (decision: boolean | 'cancelled') => {
        if (settled) { return; }
        settled = true;
        request.signal.removeEventListener('abort', onAbort);
        resolve(decision);
      };
      const onAbort = () => finish('cancelled');
      request.signal.addEventListener('abort', onAbort, { once: true });
      try {
        void Promise.resolve(options.onGate!(spec, request.toolCall, { id: request.id, signal: request.signal })).then(
          approved => finish(approved === true),
          () => finish(false),
        );
      } catch { finish(false); }
    });
  }

  /** A notification can expose an authority violation; it cannot be approved after execution. */
  private async *_gateToolUse(
    spec: CollaboratorSpec,
    options: CollaboratorDispatchOptions,
    base: Pick<CollaboratorChunk, 'collaboratorId' | 'agentId' | 'role' | 'label'>,
    childPanelId: string,
    toolCall: NonNullable<StreamChunk['toolCall']>
  ): AsyncGenerator<CollaboratorChunk, boolean> {
    if (this._providerManager.getProviderInstance?.(spec.agentId)?.capabilities.toolExecution === 'proposal-only') { return true; }
    const policy = this._toolPolicy(spec, options, toolCall);
    if (policy.decision === 'allow') {
      if (policy.mayHaveSideEffects) { this._approvedWriteChildren.add(childPanelId.replace(/-followup$/, '')); }
      return true;
    }
    yield {
      ...base, type: 'collab_tool_denied', toolCall,
      content: `Stopped ${spec.label || spec.agentId}: ${toolCall.name} was reported without native approval. The operation may already have executed. ${policy.decision === 'deny' ? policy.reason : ''}`.trim(),
    };
    this._forgetChild(options.runId, childPanelId);
    this._providerManager.cancelRequest(childPanelId);
    return false;
  }

  /**
   * Relay a collaborator's ask_user_question to the caller, then resume the
   * collaborator with the answer on a fresh follow-up process (CLIs use single-
   * shot stdin, so the original process cannot receive the answer). Mirrors
   * MentionRouter's proven question-handling path.
   */
  private async *_relayQuestion(
    spec: CollaboratorSpec,
    options: CollaboratorDispatchOptions,
    base: Pick<CollaboratorChunk, 'collaboratorId' | 'agentId' | 'role' | 'label'>,
    childPanelId: string,
    childSettings: Settings,
    questionChunk: StreamChunk,
    priorText: string
  ): AsyncGenerator<CollaboratorChunk, { responseText: string; hasError: boolean; failure?: CollaboratorFailure }> {
    let responseText = priorText;

    if (!options.onQuestion || !questionChunk.askUserQuestion) {
      // No relay available: auto-skip (backward-compatible with MentionRouter).
      const note = '\n[Collaborator wanted to ask a question — auto-skipped]\n';
      responseText += note;
      yield { ...base, type: 'collab_text', content: note };
      this._forgetChild(options.runId, childPanelId);
      this._providerManager.cancelRequest(childPanelId);
      return { responseText, hasError: false };
    }

    yield { ...base, type: 'collab_ask_user_question', askUserQuestion: questionChunk.askUserQuestion };

    // Stop the current process; it cannot consume the answer.
    this._forgetChild(options.runId, childPanelId);
    this._providerManager.cancelRequest(childPanelId);

    const userResponse = await Promise.race([
      options.onQuestion(spec.agentId, questionChunk.askUserQuestion),
      new Promise<null>(resolve => setTimeout(() => resolve(null), SUBAGENT_QUESTION_TIMEOUT_MS)),
    ]);

    if (!userResponse) {
      const skip = '\n[Question timed out — skipped]\n';
      responseText += skip;
      yield { ...base, type: 'collab_text', content: skip };
      return { responseText, hasError: false };
    }

    // Plan 18 Stop race: this generator was parked awaiting the user's answer
    // — if disposeRun reclaimed the run meanwhile, do not spawn a follow-up
    // child for a dead run.
    if (this._closedRuns.has(options.runId)) {
      return { responseText, hasError: true, failure: 'cancelled' };
    }

    const answerText = this._formatAnswers(userResponse.answers);
    const followUpPrompt = `${spec.prompt}\n\n---\n\nUser answered your questions:\n${answerText}\n\nPlease continue.`;
    const followUpPanelId = `${childPanelId}-followup`;
    this._rememberChild(options.runId, followUpPanelId);
    // Plan 18 (H2): follow-up children must be reclaimable at end-of-run too —
    // they were previously never recorded, so disposeRun couldn't reach them.
    this._recordRunChild(options.runId, followUpPanelId, spec.agentId);

    let hasError = false;
    let failure: CollaboratorFailure | undefined;
    let nativeApprovals: NativeChildApprovalScope | undefined;
    let followUpTimedOut = false;
    try {
      nativeApprovals = this._registerNativeApprovals(spec, options, followUpPanelId);
      const followUpStream = this._providerManager.sendMessageToProvider(
        spec.agentId,
        followUpPrompt,
        this._collectContext(spec),
        childSettings,
        options.conversation ?? null,
        undefined,
        followUpPanelId
      );
      // Plan 18 (1.3/M4a): same deadline discipline as the primary stream — a
      // hung follow-up otherwise parks the collaborator until run teardown.
      const followUpDeadlineMs = spec.timeoutMs ?? SUBAGENT_TIMEOUT_MS;
      for await (const chunk of this._withDeadline(followUpStream, followUpDeadlineMs, () => {
        followUpTimedOut = true;
        this._providerManager.cancelRequest(followUpPanelId);
      })) {
        if (nativeApprovals?.denied.length || nativeApprovals?.cancelled) { break; }
        if (chunk.type === 'text' && chunk.content) {
          responseText += chunk.content;
          yield { ...base, type: 'collab_text', content: chunk.content };
        } else if (chunk.type === 'thinking' && chunk.content) {
          yield { ...base, type: 'collab_thinking', content: chunk.content };
        } else if (chunk.type === 'tool_use' && chunk.toolCall) {
          const allowed = nativeApprovals ? true : yield* this._gateToolUse(spec, options, base, followUpPanelId, chunk.toolCall);
          if (!allowed) { hasError = true; failure = 'denied'; break; }
          yield { ...base, type: 'collab_tool_use', toolCall: chunk.toolCall };
        } else if (chunk.type === 'tool_result' && chunk.toolCall) {
          yield { ...base, type: 'collab_tool_result', toolCall: chunk.toolCall };
        } else if (chunk.type === 'error') {
          hasError = true; failure = 'stream-error';
          yield { ...base, type: 'collab_error', failure, content: chunk.content, hasError: true };
          break;
        }
      }
      if (followUpTimedOut) {
        hasError = true; failure = 'timeout';
        yield { ...base, type: 'collab_error', failure, content: 'Follow-up response timed out.', hasError: true };
      }
    } catch (err) {
      hasError = true; failure = 'crashed';
      yield { ...base, type: 'collab_error', failure, content: err instanceof Error ? err.message : 'Unknown error', hasError: true };
    } finally {
      nativeApprovals?.dispose();
      this._forgetChild(options.runId, followUpPanelId);
    }

    if (nativeApprovals?.denied.length) {
      hasError = true;
      failure = 'denied';
      for (const denied of nativeApprovals.denied) {
        yield { ...base, type: 'collab_tool_denied', toolCall: denied.toolCall, content: denied.reason };
      }
      this._providerManager.cancelRequest(followUpPanelId);
    } else if (nativeApprovals?.cancelled && !followUpTimedOut) {
      hasError = true;
      failure = 'cancelled';
    }

    return { responseText, hasError, failure };
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private _childPanelId(options: CollaboratorDispatchOptions, spec: CollaboratorSpec, attempt: number): string {
    const suffix = attempt > 0 ? `-retry${attempt}` : '';
    return `${options.panelId}-collab-${options.runId}-${spec.collaboratorId}${suffix}`;
  }

  private _rememberChild(runId: string, childPanelId: string): void {
    // Closed runs must stay empty — a parked child resuming after disposeRun
    // would otherwise resurrect the cancel-tracking map (Plan 18 Stop race).
    if (this._closedRuns.has(runId)) { return; }
    let set = this._activeChildPanels.get(runId);
    if (!set) {
      set = new Set();
      this._activeChildPanels.set(runId, set);
    }
    set.add(childPanelId);
  }

  /**
   * Record a child for end-of-run disposal. If the run is already closed
   * (disposeRun raced a parked child), reclaim the child immediately instead
   * of re-registering into the just-cleaned map.
   */
  private _recordRunChild(runId: string, childPanelId: string, agentId: string): void {
    if (this._closedRuns.has(runId)) {
      try {
        this._providerManager.disposePersistentProcessForProvider?.(agentId, childPanelId);
        this._providerManager.cancelRequest(childPanelId);
      } catch { /* best-effort */ }
      return;
    }
    let runChildren = this._runChildProviders.get(runId);
    if (!runChildren) { runChildren = new Map(); this._runChildProviders.set(runId, runChildren); }
    runChildren.set(childPanelId, agentId);
  }

  private _forgetChild(runId: string, childPanelId: string): void {
    this._activeChildPanels.get(runId)?.delete(childPanelId);
  }

  private _collectContext(spec: CollaboratorSpec): ContextItem[] {
    // Context is folded into the prompt by the caller (CollaborationManager);
    // the pool passes an empty context array so each spec is self-contained.
    void spec;
    return [];
  }

  private _formatAnswers(answers: Record<string, string | string[]>): string {
    const parts: string[] = [];
    for (const [header, answer] of Object.entries(answers)) {
      const formatted = Array.isArray(answer) ? answer.join(', ') : answer;
      parts.push(`**${header}**: ${formatted}`);
    }
    return parts.join('\n');
  }
}
