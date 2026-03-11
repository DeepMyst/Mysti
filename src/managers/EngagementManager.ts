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

import * as vscode from 'vscode';

// ─── Types & Interfaces ────────────────────────────────────────────────────────

export type BadgeTier = 'bronze' | 'silver' | 'gold' | 'platinum';

export type BadgeCategory =
  | 'getting-started'
  | 'milestones'
  | 'streaks'
  | 'exploration'
  | 'social'
  | 'contribution';

export interface Badge {
  id: string;
  name: string;
  description: string;
  icon: string;
  tier: BadgeTier;
  category: BadgeCategory;
  condition: BadgeCondition;
  unlockedAt?: number;
}

export type BadgeCondition =
  | { type: 'counter'; key: string; threshold: number }
  | { type: 'set'; key: string; minSize: number }
  | { type: 'streak'; days: number }
  | { type: 'composite'; badges: string[] }
  | { type: 'file-exists'; glob: string }
  | { type: 'manual'; configKey: string };

export interface BadgeProgress {
  // Counters
  totalMessages: number;
  totalConversations: number;
  totalBrainstorms: number;
  totalSlashCommands: number;
  totalAutonomousSessions: number;
  totalExports: number;
  totalDaysUsed: number;
  totalShareClicks: number;
  // Sets (stored as arrays for JSON serialization)
  providersUsed: string[];
  strategiesUsed: string[];
  personasUsed: string[];
  skillsUsed: string[];
  personaCategoriesUsed: string[];
  // Streak
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string; // YYYY-MM-DD
  // Flags
  hasStarred: boolean;
  hasReviewed: boolean;
  hasRecommendedWorkspace: boolean;
  hasCustomPersona: boolean;
  hasCustomSkill: boolean;
  // Viral Phase 2
  totalCommitsWithSignature: number;
  totalSharedConversations: number;
  hasInitializedTeam: boolean;
}

export interface LocalUsageStats {
  totalConversations: number;
  totalMessages: number;
  totalBrainstorms: number;
  dayStreak: number;
  longestStreak: number;
  providersUsed: string[];
}

export interface BadgeUnlockEvent {
  badge: Badge;
  isNew: boolean;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const PROGRESS_STATE_KEY = 'mysti.badgeProgress';
const UNLOCKED_BADGES_KEY = 'mysti.unlockedBadges';
const REVIEW_STATE_KEY = 'mysti.reviewState';

const REVIEW_MILESTONES = [25, 100, 500];
const REVIEW_MAX_DISMISSALS = 3;
const REVIEW_PERMANENT_SENTINEL = -1;

const MARKETPLACE_URL =
  'https://marketplace.visualstudio.com/items?itemName=DeepMyst.mysti';

// ─── Badge Catalog ─────────────────────────────────────────────────────────────

const BADGE_CATALOG: Badge[] = [
  // ── Getting Started (Bronze) ──────────────────────────────────────────────
  {
    id: 'first-words',
    name: 'First Words',
    description: 'Send your first message',
    icon: '💬',
    tier: 'bronze',
    category: 'getting-started',
    condition: { type: 'counter', key: 'totalMessages', threshold: 1 },
  },
  {
    id: 'setup-wizard',
    name: 'Setup Wizard',
    description: 'Complete provider setup',
    icon: '⚙️',
    tier: 'bronze',
    category: 'getting-started',
    condition: { type: 'counter', key: 'totalConversations', threshold: 1 },
  },
  {
    id: 'customizer',
    name: 'Customizer',
    description: 'Select your first persona',
    icon: '🎨',
    tier: 'bronze',
    category: 'getting-started',
    condition: { type: 'set', key: 'personasUsed', minSize: 1 },
  },

  // ── Milestones ────────────────────────────────────────────────────────────
  {
    id: 'conversationalist',
    name: 'Conversationalist',
    description: 'Start 50 conversations',
    icon: '💭',
    tier: 'silver',
    category: 'milestones',
    condition: { type: 'counter', key: 'totalConversations', threshold: 50 },
  },
  {
    id: 'power-user',
    name: 'Power User',
    description: 'Send 500 messages',
    icon: '⚡',
    tier: 'gold',
    category: 'milestones',
    condition: { type: 'counter', key: 'totalMessages', threshold: 500 },
  },
  {
    id: 'veteran',
    name: 'Veteran',
    description: 'Send 2,000 messages',
    icon: '🏆',
    tier: 'platinum',
    category: 'milestones',
    condition: { type: 'counter', key: 'totalMessages', threshold: 2000 },
  },
  {
    id: 'dedicated',
    name: 'Dedicated',
    description: 'Use Mysti for 30 days',
    icon: '📅',
    tier: 'gold',
    category: 'milestones',
    condition: { type: 'counter', key: 'totalDaysUsed', threshold: 30 },
  },

  // ── Streaks ───────────────────────────────────────────────────────────────
  {
    id: 'getting-started-streak',
    name: 'Getting Started',
    description: '3-day streak',
    icon: '🔥',
    tier: 'bronze',
    category: 'streaks',
    condition: { type: 'streak', days: 3 },
  },
  {
    id: 'on-a-roll',
    name: 'On a Roll',
    description: '7-day streak',
    icon: '🔥',
    tier: 'silver',
    category: 'streaks',
    condition: { type: 'streak', days: 7 },
  },
  {
    id: 'unstoppable',
    name: 'Unstoppable',
    description: '30-day streak',
    icon: '🔥',
    tier: 'gold',
    category: 'streaks',
    condition: { type: 'streak', days: 30 },
  },
  {
    id: 'living-legend',
    name: 'Living Legend',
    description: '100-day streak',
    icon: '👑',
    tier: 'platinum',
    category: 'streaks',
    condition: { type: 'streak', days: 100 },
  },

  // ── Exploration ───────────────────────────────────────────────────────────
  {
    id: 'polyglot',
    name: 'Polyglot',
    description: 'Use 3 different AI providers',
    icon: '🌐',
    tier: 'silver',
    category: 'exploration',
    condition: { type: 'set', key: 'providersUsed', minSize: 3 },
  },
  {
    id: 'collector',
    name: 'Collector',
    description: 'Use all 7 providers',
    icon: '🗄️',
    tier: 'platinum',
    category: 'exploration',
    condition: { type: 'set', key: 'providersUsed', minSize: 7 },
  },
  {
    id: 'team-player',
    name: 'Team Player',
    description: 'Run 10 brainstorm sessions',
    icon: '🤝',
    tier: 'silver',
    category: 'exploration',
    condition: { type: 'counter', key: 'totalBrainstorms', threshold: 10 },
  },
  {
    id: 'debate-champion',
    name: 'Debate Champion',
    description: 'Run 25 brainstorm sessions',
    icon: '🥊',
    tier: 'gold',
    category: 'exploration',
    condition: { type: 'counter', key: 'totalBrainstorms', threshold: 25 },
  },
  {
    id: 'strategist',
    name: 'Strategist',
    description: 'Try all 5 collaboration strategies',
    icon: '🧠',
    tier: 'gold',
    category: 'exploration',
    condition: { type: 'set', key: 'strategiesUsed', minSize: 5 },
  },
  {
    id: 'persona-explorer',
    name: 'Persona Explorer',
    description: 'Try 5 different personas',
    icon: '🎭',
    tier: 'silver',
    category: 'exploration',
    condition: { type: 'set', key: 'personasUsed', minSize: 5 },
  },
  {
    id: 'speed-demon',
    name: 'Speed Demon',
    description: 'Use slash commands 50 times',
    icon: '⚡',
    tier: 'silver',
    category: 'exploration',
    condition: { type: 'counter', key: 'totalSlashCommands', threshold: 50 },
  },
  {
    id: 'autonomous-pioneer',
    name: 'Autonomous Pioneer',
    description: 'Complete 10 autonomous sessions',
    icon: '🤖',
    tier: 'gold',
    category: 'exploration',
    condition: { type: 'counter', key: 'totalAutonomousSessions', threshold: 10 },
  },

  // ── Social ────────────────────────────────────────────────────────────────
  {
    id: 'first-share',
    name: 'First Share',
    description: 'Export your first conversation',
    icon: '📤',
    tier: 'bronze',
    category: 'social',
    condition: { type: 'counter', key: 'totalExports', threshold: 1 },
  },
  {
    id: 'content-creator',
    name: 'Content Creator',
    description: 'Export 10 conversations',
    icon: '✍️',
    tier: 'silver',
    category: 'social',
    condition: { type: 'counter', key: 'totalExports', threshold: 10 },
  },
  {
    id: 'star-gazer',
    name: 'Star Gazer',
    description: 'Click the GitHub star link',
    icon: '⭐',
    tier: 'bronze',
    category: 'social',
    condition: { type: 'manual', configKey: 'hasStarred' },
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Leave a marketplace review',
    icon: '📝',
    tier: 'gold',
    category: 'social',
    condition: { type: 'manual', configKey: 'hasReviewed' },
  },
  {
    id: 'megaphone',
    name: 'Megaphone',
    description: 'Share 5 times',
    icon: '📢',
    tier: 'gold',
    category: 'social',
    condition: { type: 'counter', key: 'totalShareClicks', threshold: 5 },
  },
  {
    id: 'mysti-ambassador',
    name: 'Mysti Ambassador',
    description: 'Star + Review + Share',
    icon: '🏅',
    tier: 'platinum',
    category: 'social',
    condition: { type: 'composite', badges: ['star-gazer', 'reviewer', 'first-share'] },
  },

  // ── Contribution ──────────────────────────────────────────────────────────
  {
    id: 'persona-crafter',
    name: 'Persona Crafter',
    description: 'Create a custom persona',
    icon: '🧩',
    tier: 'silver',
    category: 'contribution',
    condition: { type: 'manual', configKey: 'hasCustomPersona' },
  },
  {
    id: 'skill-smith',
    name: 'Skill Smith',
    description: 'Create a custom skill',
    icon: '🛠️',
    tier: 'silver',
    category: 'contribution',
    condition: { type: 'manual', configKey: 'hasCustomSkill' },
  },
  {
    id: 'team-builder',
    name: 'Team Builder',
    description: 'Add Mysti to workspace recommendations',
    icon: '👥',
    tier: 'gold',
    category: 'contribution',
    condition: { type: 'manual', configKey: 'hasRecommendedWorkspace' },
  },

  // ── Viral Phase 2 ─────────────────────────────────────────────────────────
  {
    id: 'trail-blazer',
    name: 'Trail Blazer',
    description: 'First commit with Mysti signature',
    icon: '🔖',
    tier: 'bronze',
    category: 'social',
    condition: { type: 'counter', key: 'totalCommitsWithSignature', threshold: 1 },
  },
  {
    id: 'team-architect',
    name: 'Team Architect',
    description: 'Initialize team config for a workspace',
    icon: '🏗️',
    tier: 'gold',
    category: 'contribution',
    condition: { type: 'manual', configKey: 'hasInitializedTeam' },
  },
  {
    id: 'conversation-sharer',
    name: 'Conversation Sharer',
    description: 'Share 5 conversations via deep link',
    icon: '🔗',
    tier: 'silver',
    category: 'social',
    condition: { type: 'counter', key: 'totalSharedConversations', threshold: 5 },
  },
];

// ─── Manager ───────────────────────────────────────────────────────────────────

/**
 * EngagementManager - Tracks usage stats, manages a badge/achievement system,
 * and handles smart review prompts.
 *
 * All state is persisted to VSCode globalState under `mysti.*` keys.
 * Tracking methods return newly unlocked badges so the caller can show
 * notifications in the webview.
 */
export class EngagementManager {
  private _context: vscode.ExtensionContext;
  private _progress: BadgeProgress;
  private _unlockedBadges: Map<string, number>; // badgeId -> unlockedAt timestamp
  private _reviewState: {
    totalResponses: number;
    hasReviewed: boolean;
    dismissedAt: number;
    dismissCount: number;
  };

  private _onBadgeUnlocked: vscode.EventEmitter<BadgeUnlockEvent>;
  public readonly onBadgeUnlocked: vscode.Event<BadgeUnlockEvent>;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;

    // Load persisted state or initialize defaults
    this._progress = this._loadProgress();
    this._unlockedBadges = this._loadUnlockedBadges();
    this._reviewState = this._loadReviewState();

    // Set up badge unlock event emitter
    this._onBadgeUnlocked = new vscode.EventEmitter<BadgeUnlockEvent>();
    this.onBadgeUnlocked = this._onBadgeUnlocked.event;
    context.subscriptions.push(this._onBadgeUnlocked);

    console.log(
      `[Mysti] EngagementManager initialized: ${this._progress.totalMessages} messages, ` +
      `${this._unlockedBadges.size} badges unlocked, ` +
      `streak: ${this._progress.currentStreak} days`
    );
  }

  // ─── Tracking Methods (called by ChatViewProvider) ──────────────────────────

  /**
   * Track a message sent by the user. Also records the provider used.
   */
  public trackMessageSent(provider: string): BadgeUnlockEvent[] {
    this._progress.totalMessages++;
    this._addToSet('providersUsed', provider);
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track a new conversation started.
   */
  public trackConversationStarted(): BadgeUnlockEvent[] {
    this._progress.totalConversations++;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track a brainstorm session completed with the given strategy.
   */
  public trackBrainstormCompleted(strategy: string): BadgeUnlockEvent[] {
    this._progress.totalBrainstorms++;
    this._addToSet('strategiesUsed', strategy);
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track a persona being selected.
   */
  public trackPersonaSelected(personaId: string, category?: string): BadgeUnlockEvent[] {
    this._addToSet('personasUsed', personaId);
    if (category) {
      this._addToSet('personaCategoriesUsed', category);
    }
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track a skill being activated.
   */
  public trackSkillActivated(skillId: string): BadgeUnlockEvent[] {
    this._addToSet('skillsUsed', skillId);
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track a slash command invocation.
   */
  public trackSlashCommandUsed(): BadgeUnlockEvent[] {
    this._progress.totalSlashCommands++;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track an autonomous session completion.
   */
  public trackAutonomousSession(): BadgeUnlockEvent[] {
    this._progress.totalAutonomousSessions++;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track a conversation export or copy.
   */
  public trackExport(): BadgeUnlockEvent[] {
    this._progress.totalExports++;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track a social share click.
   */
  public trackShareClick(): BadgeUnlockEvent[] {
    this._progress.totalShareClicks++;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track clicking the GitHub star link.
   */
  public trackStarClick(): BadgeUnlockEvent[] {
    this._progress.hasStarred = true;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track clicking the marketplace review link.
   */
  public trackReviewClick(): BadgeUnlockEvent[] {
    this._progress.hasReviewed = true;
    this._reviewState.hasReviewed = true;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track adding Mysti to workspace recommendations.
   */
  public trackWorkspaceRecommendation(): BadgeUnlockEvent[] {
    this._progress.hasRecommendedWorkspace = true;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track creation of a custom persona.
   */
  public trackCustomPersonaCreated(): BadgeUnlockEvent[] {
    this._progress.hasCustomPersona = true;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track a commit with Mysti signature.
   */
  public trackCommitWithSignature(): BadgeUnlockEvent[] {
    this._progress.totalCommitsWithSignature++;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track sharing a conversation via deep link.
   */
  public trackConversationShared(): BadgeUnlockEvent[] {
    this._progress.totalSharedConversations++;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track initializing team config via /init-team.
   */
  public trackTeamInitialized(): BadgeUnlockEvent[] {
    this._progress.hasInitializedTeam = true;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  /**
   * Track creation of a custom skill.
   */
  public trackCustomSkillCreated(): BadgeUnlockEvent[] {
    this._progress.hasCustomSkill = true;
    this._updateStreak();
    const events = this._checkBadges();
    this._saveProgress();
    return events;
  }

  // ─── Query Methods ──────────────────────────────────────────────────────────

  /**
   * Get a summary of local usage stats for display.
   */
  public getUsageStats(): LocalUsageStats {
    return {
      totalConversations: this._progress.totalConversations,
      totalMessages: this._progress.totalMessages,
      totalBrainstorms: this._progress.totalBrainstorms,
      dayStreak: this._progress.currentStreak,
      longestStreak: this._progress.longestStreak,
      providersUsed: [...this._progress.providersUsed],
    };
  }

  /**
   * Get all badges with their unlock status and current progress.
   */
  public getAllBadges(): (Badge & {
    unlocked: boolean;
    unlockedAt?: number;
    progress?: number;
    progressMax?: number;
    howTo: string;
  })[] {
    return BADGE_CATALOG.map((badge) => {
      const unlockedAt = this._unlockedBadges.get(badge.id);
      const unlocked = unlockedAt !== undefined;
      const progressInfo = this._getProgressForBadge(badge);

      return {
        ...badge,
        unlocked,
        unlockedAt: unlocked ? unlockedAt : undefined,
        progress: progressInfo?.current,
        progressMax: progressInfo?.max,
        howTo: this._getHowToText(badge),
      };
    });
  }

  private _getHowToText(badge: Badge): string {
    const c = badge.condition;
    switch (c.type) {
      case 'counter': {
        const labels: Record<string, string> = {
          totalMessages: 'Send ' + c.threshold + ' messages',
          totalConversations: 'Start ' + c.threshold + ' conversations',
          totalBrainstorms: 'Run ' + c.threshold + ' brainstorm sessions',
          totalSlashCommands: 'Use slash commands ' + c.threshold + ' times',
          totalAutonomousSessions: 'Complete ' + c.threshold + ' autonomous sessions',
          totalExports: 'Export ' + c.threshold + ' conversations',
          totalDaysUsed: 'Use Mysti for ' + c.threshold + ' days',
          totalShareClicks: 'Share ' + c.threshold + ' times',
          totalCommitsWithSignature: 'Make ' + c.threshold + ' commit' + (c.threshold > 1 ? 's' : '') + ' with Mysti signature',
          totalSharedConversations: 'Share ' + c.threshold + ' conversations via deep link',
        };
        return labels[c.key] || badge.description;
      }
      case 'set': {
        const labels: Record<string, string> = {
          providersUsed: 'Try ' + c.minSize + ' different AI providers',
          strategiesUsed: 'Try all ' + c.minSize + ' collaboration strategies',
          personasUsed: 'Try ' + c.minSize + ' different personas',
          skillsUsed: 'Activate ' + c.minSize + ' different skills',
          personaCategoriesUsed: 'Try all ' + c.minSize + ' persona categories',
        };
        return labels[c.key] || badge.description;
      }
      case 'streak':
        return 'Maintain a ' + c.days + '-day usage streak';
      case 'composite':
        return 'Unlock all required badges: Star, Review, and Share';
      case 'file-exists':
        return 'Create a custom file in your .mysti/ directory';
      case 'manual':
        return badge.description;
      default:
        return badge.description;
    }
  }

  /**
   * Get count of unlocked vs total badges.
   */
  public getUnlockedCount(): { unlocked: number; total: number } {
    return {
      unlocked: this._unlockedBadges.size,
      total: BADGE_CATALOG.length,
    };
  }

  /**
   * Generate shareable text for a specific badge.
   */
  public getBadgeShareText(badgeId: string): string {
    const badge = BADGE_CATALOG.find((b) => b.id === badgeId);
    if (!badge) {
      return '';
    }
    return (
      `I've been Mysting and just earned the ${badge.tier} ${badge.name} badge ` +
      `\u2014 ${badge.description}! #Mysting ${MARKETPLACE_URL}`
    );
  }

  // ─── Review Prompt Methods ──────────────────────────────────────────────────

  /**
   * Track a successful AI response and check if a review prompt milestone
   * has been reached.
   */
  public trackSuccessfulResponse(): void {
    this._reviewState.totalResponses++;

    const { show, milestone } = this.shouldShowReviewPrompt();
    if (show) {
      this._showReviewPrompt(milestone);
    }

    this._saveProgress();
  }

  /**
   * Check whether a review prompt should be shown based on response milestones.
   */
  public shouldShowReviewPrompt(): { show: boolean; milestone: number } {
    // Never prompt if already reviewed
    if (this._reviewState.hasReviewed) {
      return { show: false, milestone: 0 };
    }

    // Never prompt if permanently dismissed
    if (this._reviewState.dismissedAt === REVIEW_PERMANENT_SENTINEL) {
      return { show: false, milestone: 0 };
    }

    // Never prompt if max dismissals reached
    if (this._reviewState.dismissCount >= REVIEW_MAX_DISMISSALS) {
      return { show: false, milestone: 0 };
    }

    const responses = this._reviewState.totalResponses;
    for (const milestone of REVIEW_MILESTONES) {
      if (responses === milestone) {
        return { show: true, milestone };
      }
    }

    return { show: false, milestone: 0 };
  }

  /**
   * Record that the user dismissed the review prompt.
   * If permanent is true, no future prompts will be shown.
   */
  public markReviewDismissed(permanent: boolean): void {
    if (permanent) {
      this._reviewState.dismissedAt = REVIEW_PERMANENT_SENTINEL;
    } else {
      this._reviewState.dismissCount++;
      this._reviewState.dismissedAt = Date.now();
    }
    this._saveProgress();
  }

  /**
   * Record that the user has left a review.
   */
  public markReviewed(): void {
    this._reviewState.hasReviewed = true;
    this._progress.hasReviewed = true;
    this._checkBadges();
    this._saveProgress();
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Update the usage streak based on the current date.
   * If the user was active yesterday, increment the streak.
   * If the user was already active today, do nothing.
   * Otherwise, reset the streak to 1.
   */
  private _updateStreak(): void {
    const today = new Date().toISOString().split('T')[0];

    if (this._progress.lastActiveDate === today) {
      // Already counted today
      return;
    }

    // Calculate yesterday's date string
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = yesterdayDate.toISOString().split('T')[0];

    if (this._progress.lastActiveDate === yesterday) {
      // Consecutive day
      this._progress.currentStreak++;
    } else if (this._progress.lastActiveDate === '') {
      // First ever activity
      this._progress.currentStreak = 1;
    } else {
      // Streak broken
      this._progress.currentStreak = 1;
    }

    // Update longest streak if current exceeds it
    if (this._progress.currentStreak > this._progress.longestStreak) {
      this._progress.longestStreak = this._progress.currentStreak;
    }

    // Increment total days used (new unique day)
    this._progress.totalDaysUsed++;
    this._progress.lastActiveDate = today;
  }

  /**
   * Iterate the badge catalog and check each condition against current progress.
   * Fires the onBadgeUnlocked event for each newly unlocked badge.
   * Returns the list of newly unlocked badge events.
   */
  private _checkBadges(): BadgeUnlockEvent[] {
    const newlyUnlocked: BadgeUnlockEvent[] = [];

    for (const badge of BADGE_CATALOG) {
      // Skip already unlocked badges
      if (this._unlockedBadges.has(badge.id)) {
        continue;
      }

      const met = this._isConditionMet(badge.condition);
      if (met) {
        const timestamp = Date.now();
        this._unlockedBadges.set(badge.id, timestamp);

        const event: BadgeUnlockEvent = { badge, isNew: true };
        newlyUnlocked.push(event);
        this._onBadgeUnlocked.fire(event);

        console.log(
          `[Mysti] Badge unlocked: ${badge.icon} ${badge.name} (${badge.tier})`
        );
      }
    }

    return newlyUnlocked;
  }

  /**
   * Evaluate whether a single badge condition is met.
   */
  private _isConditionMet(condition: BadgeCondition): boolean {
    switch (condition.type) {
      case 'counter': {
        const value = this._getCounterValue(condition.key);
        return value >= condition.threshold;
      }
      case 'set': {
        const arr = this._getSetValue(condition.key);
        return arr !== null && arr.length >= condition.minSize;
      }
      case 'streak': {
        // Check against both current and longest streak so the badge
        // remains earned even if the current streak resets
        return (
          this._progress.currentStreak >= condition.days ||
          this._progress.longestStreak >= condition.days
        );
      }
      case 'composite': {
        return condition.badges.every((id) => this._unlockedBadges.has(id));
      }
      case 'manual': {
        const flagValue = (
          this._progress as unknown as Record<string, unknown>
        )[condition.configKey];
        return flagValue === true;
      }
      case 'file-exists': {
        // Handled by external scan; not evaluated here
        return false;
      }
      default:
        return false;
    }
  }

  /**
   * Persist all state to globalState.
   */
  private _saveProgress(): void {
    try {
      this._context.globalState.update(PROGRESS_STATE_KEY, this._progress);

      // Serialize the Map as an entries array
      const badgeEntries = Array.from(this._unlockedBadges.entries());
      this._context.globalState.update(UNLOCKED_BADGES_KEY, badgeEntries);

      this._context.globalState.update(REVIEW_STATE_KEY, this._reviewState);
    } catch (error) {
      console.error('[Mysti] EngagementManager: Failed to save progress:', error);
    }
  }

  /**
   * Calculate progress toward a badge for UI progress bars.
   */
  private _getProgressForBadge(badge: Badge): { current: number; max: number } | null {
    const condition = badge.condition;

    switch (condition.type) {
      case 'counter': {
        const value = this._getCounterValue(condition.key);
        return {
          current: Math.min(value, condition.threshold),
          max: condition.threshold,
        };
      }
      case 'set': {
        const arr = this._getSetValue(condition.key);
        const length = arr ? arr.length : 0;
        return {
          current: Math.min(length, condition.minSize),
          max: condition.minSize,
        };
      }
      case 'streak': {
        const best = Math.max(
          this._progress.currentStreak,
          this._progress.longestStreak
        );
        return {
          current: Math.min(best, condition.days),
          max: condition.days,
        };
      }
      case 'composite': {
        const unlocked = condition.badges.filter((id) =>
          this._unlockedBadges.has(id)
        ).length;
        return {
          current: unlocked,
          max: condition.badges.length,
        };
      }
      case 'manual': {
        const flagValue = (
          this._progress as unknown as Record<string, unknown>
        )[condition.configKey];
        return {
          current: flagValue === true ? 1 : 0,
          max: 1,
        };
      }
      default:
        return null;
    }
  }

  /**
   * Read a numeric counter value from progress by key name.
   */
  private _getCounterValue(key: string): number {
    const value = (this._progress as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : 0;
  }

  /**
   * Read an array (set) value from progress by key name.
   */
  private _getSetValue(key: string): string[] | null {
    const value = (this._progress as unknown as Record<string, unknown>)[key];
    return Array.isArray(value) ? (value as string[]) : null;
  }

  /**
   * Add a value to a set-type field in progress (deduplicating).
   */
  private _addToSet(
    key: 'providersUsed' | 'strategiesUsed' | 'personasUsed' | 'skillsUsed' | 'personaCategoriesUsed',
    value: string
  ): void {
    if (!this._progress[key].includes(value)) {
      this._progress[key].push(value);
    }
  }

  /**
   * Show an interactive review prompt via VS Code information message.
   */
  private async _showReviewPrompt(milestone: number): Promise<void> {
    console.log(
      `[Mysti] EngagementManager: Showing review prompt at ${milestone} responses`
    );

    const selection = await vscode.window.showInformationMessage(
      `You've received ${milestone} AI responses with Mysti! If you're enjoying it, would you consider leaving a review?`,
      'Rate on Marketplace',
      'Remind Me Later',
      "Don't Ask Again"
    );

    if (selection === 'Rate on Marketplace') {
      vscode.env.openExternal(vscode.Uri.parse(MARKETPLACE_URL));
      this.markReviewed();
    } else if (selection === "Don't Ask Again") {
      this.markReviewDismissed(true);
    } else {
      // "Remind Me Later" or dismissed
      this.markReviewDismissed(false);
    }
  }

  // ─── Persistence Loaders ────────────────────────────────────────────────────

  /**
   * Load badge progress from globalState, returning defaults if absent.
   */
  private _loadProgress(): BadgeProgress {
    try {
      const stored = this._context.globalState.get<BadgeProgress>(PROGRESS_STATE_KEY);
      if (stored) {
        // Merge with defaults to handle newly added fields across versions
        return { ...this._createDefaultProgress(), ...stored };
      }
    } catch (error) {
      console.error('[Mysti] EngagementManager: Failed to load progress:', error);
    }
    return this._createDefaultProgress();
  }

  /**
   * Load unlocked badges map from globalState.
   * Stored as [badgeId, timestamp] entries array.
   */
  private _loadUnlockedBadges(): Map<string, number> {
    const map = new Map<string, number>();
    try {
      const stored = this._context.globalState.get<[string, number][]>(UNLOCKED_BADGES_KEY);
      if (stored && Array.isArray(stored)) {
        for (const [badgeId, timestamp] of stored) {
          map.set(badgeId, timestamp);
        }
      }
    } catch (error) {
      console.error('[Mysti] EngagementManager: Failed to load unlocked badges:', error);
    }
    return map;
  }

  /**
   * Load review state from globalState.
   */
  private _loadReviewState(): {
    totalResponses: number;
    hasReviewed: boolean;
    dismissedAt: number;
    dismissCount: number;
  } {
    try {
      const stored = this._context.globalState.get<{
        totalResponses: number;
        hasReviewed: boolean;
        dismissedAt: number;
        dismissCount: number;
      }>(REVIEW_STATE_KEY);
      if (stored) {
        return {
          totalResponses: stored.totalResponses ?? 0,
          hasReviewed: stored.hasReviewed ?? false,
          dismissedAt: stored.dismissedAt ?? 0,
          dismissCount: stored.dismissCount ?? 0,
        };
      }
    } catch (error) {
      console.error('[Mysti] EngagementManager: Failed to load review state:', error);
    }
    return {
      totalResponses: 0,
      hasReviewed: false,
      dismissedAt: 0,
      dismissCount: 0,
    };
  }

  /**
   * Create the default (empty) badge progress object.
   */
  private _createDefaultProgress(): BadgeProgress {
    return {
      totalMessages: 0,
      totalConversations: 0,
      totalBrainstorms: 0,
      totalSlashCommands: 0,
      totalAutonomousSessions: 0,
      totalExports: 0,
      totalDaysUsed: 0,
      totalShareClicks: 0,
      providersUsed: [],
      strategiesUsed: [],
      personasUsed: [],
      skillsUsed: [],
      personaCategoriesUsed: [],
      currentStreak: 0,
      longestStreak: 0,
      lastActiveDate: '',
      hasStarred: false,
      hasReviewed: false,
      hasRecommendedWorkspace: false,
      hasCustomPersona: false,
      hasCustomSkill: false,
      totalCommitsWithSignature: 0,
      totalSharedConversations: 0,
      hasInitializedTeam: false,
    };
  }

  /**
   * Clean up resources.
   */
  public dispose(): void {
    this._saveProgress();
    this._onBadgeUnlocked.dispose();
    console.log('[Mysti] EngagementManager disposed');
  }
}
