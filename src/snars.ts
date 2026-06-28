// Assess a GoalChainer claim with a Subjective-Logic NARS deduction on @metta-ts,
// driven through the typed eDSL. Ports goal_chainer/snars_query.py (derive_incident).
//
// Each premise is a belief from evidence (9 positive, 0 negative -> opinion via the
// W=2 non-informative prior). The two premises chain through a subjective-logic
// deduction. The opinion arithmetic (the prior mapping, the chained belief, the
// projected expectation) is computed on the @metta-ts interpreter. The numbers are
// identical to the SNARS run: premise (0.818182, 0, 0.181818, 0.5), derived
// (0.669421, 0, 0.330579, 0.5), expectation 0.834711.

import { div, add, sub, mul, type Term } from "@metta-ts/edsl";
import { mettaDB, num, flt, type MettaDB } from "./engine.js";
import { extractEvidence } from "./evidence.js";
import { round6 } from "./models.js";

const ENGINE = "SNARS deduction (Subjective-Logic NARS) on @metta-ts";

interface Opinion {
  b: number;
  d: number;
  u: number;
  a: number;
}

const roundOpinion = (o: Opinion): Opinion => ({
  b: round6(o.b),
  d: round6(o.d),
  u: round6(o.u),
  a: round6(o.a),
});

// Render a float the way Python's repr does (so 0 -> "0.0"), for the why receipt.
const pyFloat = (x: number): string => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const opinionStr = (o: Opinion): string =>
  `(Opinion ${pyFloat(o.b)} ${pyFloat(o.d)} ${pyFloat(o.u)} ${pyFloat(o.a)})`;

/** Map evidence (positive, negative) to an opinion on the engine, W=2 prior. */
function premiseOpinion(db: MettaDB, wPos: number, wNeg: number): Opinion {
  const total: Term = add(add(flt(wPos), flt(wNeg)), flt(2));
  return { b: num(db, div(flt(wPos), total)), d: 0, u: num(db, div(flt(2), total)), a: 0.5 };
}

export function derive(
  subject: string,
  middle: string,
  conclusion: string,
): {
  claim: string;
  engine: string;
  derived: boolean;
  opinion: Opinion;
  expectation: number;
  proof: { rule: string; premises: { statement: string; opinion: Opinion }[] };
  why: string;
} {
  const db = mettaDB();
  const p1 = premiseOpinion(db, 9.0, 0.0);
  const p2 = premiseOpinion(db, 9.0, 0.0);
  // Chained deduction (d=0 premises): b = b1*b2, u = 1 - b, expectation = b + 0.5*u.
  const b = num(db, mul(p1.b, p2.b));
  const u = num(db, sub(1, b));
  const expectation = num(db, add(b, mul(0.5, u)));
  const opinion: Opinion = { b, d: 0, u, a: 0.5 };

  const s1 = `${subject} is ${middle}.`;
  const s2 = `${middle} is ${conclusion}.`;
  const why =
    `(because ded ((premise "${s1}" ${opinionStr(p1)}) ` +
    `(premise "${s2}" ${opinionStr(p2)})) ())`;
  return {
    claim: `${subject} is ${conclusion}`,
    engine: ENGINE,
    derived: true,
    opinion: roundOpinion(opinion),
    expectation: round6(expectation),
    proof: {
      rule: "deduction",
      premises: [
        { statement: s1, opinion: roundOpinion(p1) },
        { statement: s2, opinion: roundOpinion(p2) },
      ],
    },
    why,
  };
}

/** Ground the deduction in the request itself, as derive_incident does. */
export function deriveIncident(request: string): Record<string, unknown> {
  const evidence = extractEvidence(request);
  const grounding = evidence.riskGrounding || "the incident request";
  const result = derive("publish_raw_log", "risky_action", "forbidden_action");
  return {
    ...result,
    grounding,
    privacy_at_stake: evidence.sensitiveCategories.length > 0 && !evidence.publicDeclared,
    evidence_provenance: evidence.provenance,
  };
}
