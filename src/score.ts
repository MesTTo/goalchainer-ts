// Rank actions by goal coverage, derived deontic status, and graded evidence.
// Ports goal_chainer/scoring.py + native_score.py + gc_score.pl.
//
// The combined score runs on the @metta-ts engine for both paths: the native path
// (when MetaMo consensus is supplied) is 0.54*motivation + 0.38*(strength*confidence)
// + bonus; the offline path is 0.42*goal + 0.38*evidence + 0.12*fairness_floor +
// bonus. The deontic gate (forbidden -> -1.0) and the status thresholds are
// control flow, kept in TypeScript.

import { add, mul, type Term } from "@metta-ts/edsl";
import { mettaDB, mmin, num, type MettaDB } from "./engine.js";
import type { CandidateAction, Decision, EvidenceProjection, Goal, GoalScenario } from "./models.js";

const BLOCKING_STATUSES = new Set(["forbidden", "conflict"]);

const nativeScoreExpr = (strength: number, confidence: number, motivation: number, bonus: number): Term =>
  add(add(mul(0.54, motivation), mul(0.38, mul(strength, confidence))), bonus);

const offlineScoreExpr = (
  goal: number,
  strength: number,
  confidence: number,
  individual: number,
  collective: number,
  bonus: number,
): Term =>
  add(
    add(add(mul(0.42, goal), mul(0.38, mul(strength, confidence))), mul(0.12, mmin(individual, collective))),
    bonus,
  );

interface Reasoner {
  source: string;
  project(action: CandidateAction): EvidenceProjection;
}

export class DecisionEngine {
  private readonly db: MettaDB = mettaDB();

  constructor(
    private readonly reasoner: Reasoner,
    private readonly motivationScores: Record<string, number> = {},
  ) {}

  rank(scenario: GoalScenario): Decision[] {
    const motivation = normalizedMotivation(scenario, this.motivationScores);
    const decisions = scenario.actions.map((action) =>
      this.evaluateAction(scenario, action, motivation[action.id]),
    );
    return decisions.sort((a, b) => b.score - a.score);
  }

  private evaluateAction(
    scenario: GoalScenario,
    action: CandidateAction,
    motivation: number | undefined,
  ): Decision {
    const evidence = this.reasoner.project(action);
    const goalScores = goalCoverage(scenario.goals, action.satisfies);
    const deontic = evidence.deontic;
    const missingRequired = missingRequiredGoals(scenario.goals, action.satisfies);
    const blocked = BLOCKING_STATUSES.has(deontic);

    const warnings: string[] = [];
    if (missingRequired.length > 0) warnings.push("missing required goals: " + missingRequired.join(", "));
    if (blocked) warnings.push(`native deontic status: ${deontic}`);

    let score: number;
    let status: string;
    if (blocked) {
      score = -1.0;
      status = "blocked";
    } else {
      const bonus = deontic === "obligated" ? 0.1 : 0.0;
      score =
        motivation !== undefined
          ? num(this.db, nativeScoreExpr(evidence.strength, evidence.confidence, motivation, bonus))
          : num(
              this.db,
              offlineScoreExpr(goalScores.all, evidence.strength, evidence.confidence, goalScores.individual, goalScores.collective, bonus),
            );
      status = decisionStatus(score, missingRequired);
    }

    const metadata: Record<string, string> = { deontic_expectation: evidence.expectation.toFixed(6) };
    if (motivation !== undefined) {
      metadata.motivation = motivation.toFixed(4);
      metadata.score_engine = "metta-ts";
    }

    return {
      actionId: action.id,
      label: action.label,
      status,
      score,
      goalScore: goalScores.all,
      individualScore: goalScores.individual,
      collectiveScore: goalScores.collective,
      evidence,
      normStatus: deontic,
      normReasons: [`expectation=${evidence.expectation.toFixed(3)}`],
      satisfiedGoals: [...action.satisfies],
      missingRequiredGoals: missingRequired,
      warnings,
      metadata,
    };
  }
}

function normalizedMotivation(
  scenario: GoalScenario,
  motivationScores: Record<string, number>,
): Record<string, number> {
  const values = scenario.actions.filter((a) => a.id in motivationScores).map((a) => motivationScores[a.id]!);
  if (values.length < scenario.actions.length || values.length === 0) return {};
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low;
  const out: Record<string, number> = {};
  for (const a of scenario.actions) {
    out[a.id] = span ? (motivationScores[a.id]! - low) / span : 1.0;
  }
  return out;
}

interface GoalScores {
  all: number;
  individual: number;
  collective: number;
}

function goalCoverage(goals: readonly Goal[], satisfied: readonly string[]): GoalScores {
  const satisfiedSet = new Set(satisfied);
  return {
    all: weightedCoverage(goals, satisfiedSet),
    individual: weightedCoverage(goals.filter((g) => g.kind === "individual"), satisfiedSet),
    collective: weightedCoverage(goals.filter((g) => g.kind === "collective"), satisfiedSet),
  };
}

function weightedCoverage(goals: readonly Goal[], satisfied: Set<string>): number {
  const total = goals.reduce((s, g) => s + g.weight, 0);
  if (total === 0) return 0.0;
  const covered = goals.filter((g) => satisfied.has(g.id)).reduce((s, g) => s + g.weight, 0);
  return covered / total;
}

function missingRequiredGoals(goals: readonly Goal[], satisfied: readonly string[]): string[] {
  const satisfiedSet = new Set(satisfied);
  return goals.filter((g) => g.required && !satisfiedSet.has(g.id)).map((g) => g.id);
}

function decisionStatus(score: number, missingRequired: string[]): string {
  if (score >= 0.72 && missingRequired.length === 0) return "recommended";
  if (score >= 0.5) return "candidate";
  return "weak";
}
