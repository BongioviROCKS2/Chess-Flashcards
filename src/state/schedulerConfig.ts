export type PresetName = 'Beginner' | 'Standard' | 'Aggressive';

export type SchedulerConfig = {
  preset: PresetName;
  // Ease
  initialEase: number; // EF start
  minEase: number;
  maxEase: number;
  easeDelta: { again: number; hard: number; good: number; easy: number };

  // Learning and graduation
  learningStepsMins: number[]; // e.g. [1, 10]
  graduateGoodDays: number;    // days on 'good'
  graduateEasyDays: number;    // days on 'easy'
  seedGoodDays: number;        // used for batch seed

  // Multipliers post-graduation
  againMultiplier: number;
  hardMultiplier: number;
  goodMultiplier: number;
  easyMultiplier: number;

  // Stability model (heuristic)
  initialStabilityDays: number;
  minStabilityDays: number;
  maxStabilityDays: number;
  stabilityGrowth: number;     // per successful review relative growth
  lapseStabilityDecay: number; // on lapses

  // Early/late penalties
  tolerantWindowMins: number;  // no penalty within
  earlyReviewFactor: number;   // base shrink when early
  earlyTargetMins: number;     // denom scale for early ratio
  lateReviewSlope: number;     // per-day late multiplier slope
  maxLateDaysPenalty: number;  // cap days considered for penalty

  // Global
  intervalMultiplier: number;  // multiply final minutes
  minIntervalMin: number;      // floor minutes
};

const KEY = 'chessflashcards.scheduler.config.v1';

const PRESETS: Record<PresetName, Omit<SchedulerConfig, 'preset'>> = {
  Beginner: {
    initialEase: 2.5,
    minEase: 1.3,
    maxEase: 3.5,
    easeDelta: { again: -0.2, hard: -0.05, good: 0.0, easy: 0.15 },

    learningStepsMins: [1, 10],
    graduateGoodDays: 2,
    graduateEasyDays: 4,
    seedGoodDays: 2,

    againMultiplier: 0.5,
    hardMultiplier: 1.2,
    goodMultiplier: 2.4,
    easyMultiplier: 3.2,

    initialStabilityDays: 1.0,
    minStabilityDays: 0.5,
    maxStabilityDays: 3650,
    stabilityGrowth: 0.15,
    lapseStabilityDecay: 0.5,

    tolerantWindowMins: 60,  // 1h
    earlyReviewFactor: 0.9,
    earlyTargetMins: 24*60,
    lateReviewSlope: 0.04,
    maxLateDaysPenalty: 10,

    intervalMultiplier: 1.0,
    minIntervalMin: 1,
  },
  Standard: {
    initialEase: 2.35,
    minEase: 1.3,
    maxEase: 3.5,
    easeDelta: { again: -0.2, hard: -0.03, good: 0.0, easy: 0.15 },

    learningStepsMins: [1, 10],
    graduateGoodDays: 3,
    graduateEasyDays: 5,
    seedGoodDays: 3,

    againMultiplier: 0.4,
    hardMultiplier: 1.4,
    goodMultiplier: 2.6,
    easyMultiplier: 3.6,

    initialStabilityDays: 1.2,
    minStabilityDays: 0.5,
    maxStabilityDays: 3650,
    stabilityGrowth: 0.18,
    lapseStabilityDecay: 0.45,

    tolerantWindowMins: 90,
    earlyReviewFactor: 0.85,
    earlyTargetMins: 24*60,
    lateReviewSlope: 0.05,
    maxLateDaysPenalty: 14,

    intervalMultiplier: 1.0,
    minIntervalMin: 1,
  },
  Aggressive: {
    initialEase: 2.3,
    minEase: 1.25,
    maxEase: 3.7,
    easeDelta: { again: -0.25, hard: -0.05, good: 0.02, easy: 0.18 },

    learningStepsMins: [1, 5],
    graduateGoodDays: 4,
    graduateEasyDays: 7,
    seedGoodDays: 4,

    againMultiplier: 0.35,
    hardMultiplier: 1.5,
    goodMultiplier: 2.8,
    easyMultiplier: 4.0,

    initialStabilityDays: 1.3,
    minStabilityDays: 0.5,
    maxStabilityDays: 3650,
    stabilityGrowth: 0.22,
    lapseStabilityDecay: 0.4,

    tolerantWindowMins: 120,
    earlyReviewFactor: 0.8,
    earlyTargetMins: 24*60,
    lateReviewSlope: 0.06,
    maxLateDaysPenalty: 21,

    intervalMultiplier: 1.0,
    minIntervalMin: 1,
  },
};

function defaults(preset: PresetName = 'Standard'): SchedulerConfig {
  return { preset, ...PRESETS[preset] };
}

export function getSchedulerConfig(): SchedulerConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults('Standard');
    const parsed = JSON.parse(raw);
    const presetName: PresetName = parsed?.preset || 'Standard';
    return { ...defaults(presetName), ...(parsed || {}) };
  } catch {
    return defaults('Standard');
  }
}

export function setSchedulerConfig(patch: Partial<SchedulerConfig> & { preset?: PresetName }): SchedulerConfig {
  const cur = getSchedulerConfig();
  const next = { ...cur, ...patch } as SchedulerConfig;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
  return next;
}

export function getPresets(): { name: PresetName; config: SchedulerConfig }[] {
  return (['Beginner','Standard','Aggressive'] as PresetName[]).map(p => ({ name: p, config: defaults(p) }));
}

