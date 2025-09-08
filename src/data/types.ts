// src/data/types.ts

export type EvalInfo = {
  kind: 'cp' | 'mate';
  value: number;
  depth?: number;
};

/**
 * CardFields
 *
 * Front inputs:
 *  - moveSequence: PGN (SAN tokens) to reach review position
 *  - fen: review FEN
 *
 * Back inputs:
 *  - answer: best move (SAN)
 *  - answerFen?: FEN after best move (optional)
 *  - eval?: engine evaluation (stored raw; UI renders white-centric)
 *  - exampleLine?: SAN[] from review FEN
 *  - otherAnswers?: SAN[] alternatives
 *
 * Lineage (new model):
 *  - depth: move number per spec (derived from plies)
 *  - parent?: id of immediate parent card (optional for depth 1 white/black)
 *  - children?: string[]  immediate children (positions after playing this card's best answer, then one opponent reply)
 *  - descendants?: string[] all descendants (children + their children, etc.), computed at load
 *
 * (No `last` flag anymore.)
 */
export type CardFields = {
  // Front
  moveSequence: string;
  fen: string;

  // Back
  answer: string;
  answerFen?: string;
  eval?: EvalInfo;
  exampleLine?: string[];
  otherAnswers?: (string | { move: string; eval?: EvalInfo })[];
  siblingAnswers?: string[];

  // Lineage
  depth: number;
  parent?: string;
  children?: string[];     // immediate children
  descendants?: string[];  // transitive closure of children
  // creation metadata
  creationCriteria?: any;

  // (Legacy/optional scratch fields allowed but not required)
  parentInterval?: number;
  ancestors?: string[];
  ancestorsInterval?: number;

  // User feedback (optional)
  suggestedAnswer?: string;
  nonViableAnswers?: string[];
  wrongAnswers?: string[];
};

export type Card = {
  id: string;
  deck: string;
  tags: string[];
  fields: CardFields;
  options?: Record<string, unknown>;
  due?: 'new' | string; // ISO
};
