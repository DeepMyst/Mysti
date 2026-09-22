import type { GatewayChatMessage } from '../services/DeepMystGatewayClient';
import type { MystiDirective } from '../utils/mystiDelegateParser';
import type { CoordinatorToolDispatch } from './CoordinatorToolDispatcher';
import type { CoordinatorTurnResult } from './CoordinatorTurnRunner';

export interface CoordinatorRunOrchestratorPorts {
  turns(messages: GatewayChatMessage[]): AsyncIterable<CoordinatorTurnResult>;
  dispatchTool(turn: Extract<CoordinatorTurnResult, { kind: 'turn' }>, messages: GatewayChatMessage[]): Promise<CoordinatorToolDispatch>;
  delegate(directive: Extract<MystiDirective, { kind: 'delegate' }>, text: string, messages: GatewayChatMessage[]): Promise<'handled' | 'cancelled'>;
  isCancelled(): boolean;
  hasVisibleText(): boolean;
  finalize(messages: GatewayChatMessage[]): Promise<void>;
  onError(turn: Extract<CoordinatorTurnResult, { kind: 'error' }>): void;
}

export interface CoordinatorRunOutcome {
  errored: boolean;
  naturalEnd: boolean;
  exhausted: boolean;
}

/**
 * One run's serial model → tool → delegation loop. Turn and tool owners enforce
 * their own budgets; this owner decides when to stop or attempt the one rescue.
 * Permission effects, fencing, output persistence and cleanup stay in ports.
 */
export class CoordinatorRunOrchestrator {
  private _started = false;

  constructor(private readonly _ports: CoordinatorRunOrchestratorPorts) {}

  async run(messages: GatewayChatMessage[]): Promise<CoordinatorRunOutcome> {
    if (this._started) { throw new Error('Coordinator orchestration can only run once'); }
    this._started = true;
    let errored = false;
    let naturalEnd = false;
    let cancelled = this._ports.isCancelled();

    if (!cancelled) {
      for await (const turn of this._ports.turns(messages)) {
        // Both iterator delivery and every effect handoff can outlive ownership.
        if (this._ports.isCancelled()) { cancelled = true; break; }
        if (turn.kind === 'error') {
          errored = true;
          this._ports.onError(turn);
          break;
        }
        const replayFrom = messages.length;
        const dispatch = await this._ports.dispatchTool(turn, messages);
        attachReasoning(messages, replayFrom, turn.reasoningDetails);
        if (this._ports.isCancelled() || dispatch.kind === 'cancelled') { cancelled = true; break; }
        if (dispatch.kind === 'handled') { continue; }
        if (dispatch.directive?.kind === 'delegate') {
          const result = await this._ports.delegate(dispatch.directive, turn.text, messages);
          attachReasoning(messages, replayFrom, turn.reasoningDetails);
          if (this._ports.isCancelled() || result === 'cancelled') { cancelled = true; break; }
          continue;
        }
        // Preserve the existing fallback for an unhandled non-delegate kind.
        naturalEnd = true;
        break;
      }
    }

    // Iterator completion/return can also wait while the owner is superseded.
    cancelled ||= this._ports.isCancelled();
    if (!cancelled && !errored && !this._ports.hasVisibleText()) {
      await this._ports.finalize(messages);
      cancelled = this._ports.isCancelled();
      if (!cancelled && this._ports.hasVisibleText()) { naturalEnd = true; }
    }
    return { errored, naturalEnd, exhausted: !naturalEnd && !errored && !cancelled };
  }
}

/**
 * Every tool/delegation owner replays a turn as `assistant(turn text)` followed
 * by the fenced result. Attach the turn's opaque reasoning to that assistant
 * message here, once, instead of at each of the owners' replay sites, so the
 * next request carries it unmodified (OpenRouter reasoning continuity).
 */
function attachReasoning(messages: GatewayChatMessage[], from: number, details?: Record<string, unknown>[]): void {
  if (!details?.length) { return; }
  const replay = messages.slice(from).find(message => message.role === 'assistant');
  if (replay && !replay.reasoning_details) { replay.reasoning_details = details; }
}
