// Individual vs collective goals as a MetaMo-style consensus on @metta-ts, driven
// through the typed eDSL. Ports goal_chainer/motivation.py.
//
// Each candidate action carries its goal correlations and risk. The subsystem
// scores (goals . corr - risk) and the disagreement-penalized consensus
//   consensus = (scoreI + scoreC)/2 - 0.25*|scoreI - scoreC|
// are computed on the @metta-ts interpreter. The argmax selections (which action
// each subsystem prefers, the winner) stay in TypeScript.

import { add, sub, mul, div, type Term } from "@metta-ts/edsl";
import { mettaDB, mabs, num, type MettaDB } from "./engine.js";
import { roundN } from "./models.js";
import type { GoalScenario } from "./models.js";

const ENGINE = "MetaMo consensusAction (OpenPsi/MAGUS) on @metta-ts";

const CORRELATIONS: Record<string, Record<string, number>> = {
  publish_raw_log: { preserve_privacy: -1.0, restore_service: 1.0, coordinate_team: 1.0 },
  publish_redacted_summary: { preserve_privacy: 1.0, restore_service: 0.9, coordinate_team: 0.7 },
  hold_external_update: { preserve_privacy: 1.0, restore_service: 0.0, coordinate_team: 0.0 },
};

const correlation = (actionId: string, goalId: string): number => CORRELATIONS[actionId]?.[goalId] ?? 0.0;

interface Candidate {
  id: string;
  corr: number[];
  risk: number;
}

const dot = (g: number[], c: number[]): Term =>
  g.reduce<Term>((acc, gi, i) => (i === 0 ? mul(gi, c[i]!) : add(acc, mul(gi, c[i]!))), 0);

const scoreExpr = (goals: number[], c: Candidate, withRisk: boolean): Term =>
  withRisk ? sub(dot(goals, c.corr), c.risk) : dot(goals, c.corr);

function bestBy(db: MettaDB, goals: number[], candidates: Candidate[], withRisk: boolean): string {
  let best = candidates[0]!;
  let bestScore = num(db, scoreExpr(goals, best, withRisk));
  for (const c of candidates.slice(1)) {
    const s = num(db, scoreExpr(goals, c, withRisk));
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best.id;
}

export interface MotivationResult {
  engine: string;
  individual_goals: number[];
  collective_goals: number[];
  candidates: { id: string; corr: number[]; risk: number }[];
  goal_pull: { individual: string; collective: string };
  subsystem_preference: { individual: string; collective: string };
  consensus_scores: Record<string, number>;
  consensus: string;
}

export function consensusDecision(
  scenario: GoalScenario,
  strengthByAction: Record<string, number>,
): MotivationResult {
  const db = mettaDB();
  const goals = scenario.goals;
  const individual = goals.map((g) => (g.kind === "individual" ? 1.0 : 0.0));
  const collective = goals.map((g) => (g.kind === "collective" ? 1.0 : 0.0));

  const candidates: Candidate[] = scenario.actions.map((action) => ({
    id: action.id,
    corr: goals.map((g) => correlation(action.id, g.id)),
    risk: roundN(1.0 - strengthByAction[action.id]!, 3),
  }));

  const consensusScores: Record<string, number> = {};
  for (const c of candidates) {
    const sI = scoreExpr(individual, c, true);
    const sC = scoreExpr(collective, c, true);
    // (sI + sC)/2 - 0.25*|sI - sC|
    consensusScores[c.id] = num(db, sub(div(add(sI, sC), 2), mul(0.25, mabs(sub(sI, sC)))));
  }
  const chosen = candidates.reduce((best, c) =>
    consensusScores[c.id]! > consensusScores[best.id]! ? c : best,
  ).id;

  return {
    engine: ENGINE,
    individual_goals: individual,
    collective_goals: collective,
    candidates: candidates.map((c) => ({ id: c.id, corr: c.corr, risk: c.risk })),
    goal_pull: {
      individual: bestBy(db, individual, candidates, false),
      collective: bestBy(db, collective, candidates, false),
    },
    subsystem_preference: {
      individual: bestBy(db, individual, candidates, true),
      collective: bestBy(db, collective, candidates, true),
    },
    consensus_scores: consensusScores,
    consensus: chosen,
  };
}

export function motivationSummary(m: MotivationResult | null): Record<string, unknown> | null {
  if (m === null) return null;
  return {
    engine: m.engine,
    goal_pull: m.goal_pull,
    subsystem_preference: m.subsystem_preference,
    consensus: m.consensus,
  };
}
