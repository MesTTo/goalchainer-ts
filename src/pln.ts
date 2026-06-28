// Grade each action's acceptability with a PLN contextual query on @metta-ts,
// driven through the typed eDSL. Ports goal_chainer/evidence_chainer.py.
//
// Implication rules and per-action facts (each an STV) are typed atoms added to
// the engine. A rule matches each fact to its implication by predicate and emits
// the modus-ponens deduction, with the deduction arithmetic evaluated on the
// interpreter. When an action has more than one supporting fact, the deductions
// are merged by PLN revision, also computed on the engine. The deduction and
// revision math is byte-identical to PeTTaChainer's TotalMpFormula and count-space
// (K=800) revision.

import { rel, S, v, e, matchSelf, add, sub, mul, div, type Term } from "@metta-ts/edsl";
import { mettaDB, mmin } from "./engine.js";
import { ACTION_ORDER } from "./deontic.js";
import type { IncidentEvidence } from "./evidence.js";
import { privacyAtStake } from "./evidence.js";

export interface Belief {
  strength: number;
  confidence: number;
  proof: string;
}

// Predicate -> (ruleName, ruleStrength, ruleConfidence).
const RULES: Record<string, [string, number, number]> = {
  SupportsCollective: ["support_to_accept", 0.92, 0.95],
  Redacted: ["redaction_to_accept", 0.95, 0.97],
  ProtectsPrivacy: ["protect_to_accept", 0.85, 0.92],
  RisksPrivacy: ["risk_to_accept", 0.05, 0.9],
};

const RULE_ORDER = ["redaction_to_accept", "support_to_accept", "protect_to_accept", "risk_to_accept"];

// Truth-value math as engine arithmetic. deduction: TotalMpFormula with the
// (0.2 0.2) NOT-premise fallback; revision: count-space, K=800.
const dedS = (rs: Term, fs: Term): Term => add(mul(rs, fs), mul(0.2, sub(1, fs)));
const dedC = (rc: Term, fc: Term, fs: Term): Term =>
  add(mul(fs, mmin(rc, fc)), mul(sub(1, fs), mmin(0.2, fc)));
const c2w = (c: Term): Term => div(mul(c, 800), sub(1, mmin(c, 0.9999)));
const revS = (s1: Term, c1: Term, s2: Term, c2: Term): Term =>
  div(add(mul(s1, c2w(c1)), mul(s2, c2w(c2))), add(c2w(c1), c2w(c2)));
const revC = (c1: Term, c2: Term): Term =>
  div(add(c2w(c1), c2w(c2)), add(add(c2w(c1), c2w(c2)), 800));

interface Fact {
  action: string;
  name: string;
  predicate: string;
  fs: number;
  fc: number;
}

function factsFor(evidence: IncidentEvidence): Fact[] {
  const facts: Fact[] = [];
  if (privacyAtStake(evidence)) {
    const freq = Math.min(0.98, 0.6 + 0.1 * evidence.sensitiveCategories.length);
    facts.push({ action: "publish_raw_log", name: "raw_risk", predicate: "RisksPrivacy", fs: freq, fc: 0.95 });
  } else {
    facts.push({ action: "publish_raw_log", name: "raw_support", predicate: "SupportsCollective", fs: 0.95, fc: 0.95 });
  }
  const support = evidence.factsReady ? 0.95 : 0.55;
  facts.push({ action: "publish_redacted_summary", name: "red_support", predicate: "SupportsCollective", fs: support, fc: 0.95 });
  facts.push({ action: "publish_redacted_summary", name: "red_redacted", predicate: "Redacted", fs: 1.0, fc: 0.97 });
  const protect = evidence.factsReady ? 0.85 : 0.95;
  facts.push({ action: "hold_external_update", name: "hold_protect", predicate: "ProtectsPrivacy", fs: protect, fc: 0.92 });
  return facts;
}

export function gradeBeliefs(evidence: IncidentEvidence): {
  beliefs: Record<string, Belief>;
  program: string;
  rawOutputs: string[];
} {
  const db = mettaDB();
  const ruleAtoms = Object.entries(RULES).map(([pred, [name, rs, rc]]) => rel("rule")(S(pred), S(name), rs, rc));
  const factAtoms = factsFor(evidence).map((f) => rel("fact")(S(f.action), S(f.name), S(f.predicate), f.fs, f.fc));
  db.add(...ruleAtoms, ...factAtoms);

  // Match each fact to its rule by predicate, deduce on the engine.
  db.rule(
    rel("ded")(v("act")),
    matchSelf(
      rel("fact")(v("act"), v("fn"), v("pred"), v("fs"), v("fc")),
      matchSelf(
        rel("rule")(v("pred"), v("rn"), v("rs"), v("rc")),
        e(v("rn"), v("fn"), dedS(v("rs"), v("fs")), dedC(v("rc"), v("fc"), v("fs"))),
      ),
    ),
  );

  const beliefs: Record<string, Belief> = {};
  const rawOutputs: string[] = [];
  for (const action of ACTION_ORDER) {
    const deductions = (db.evalJs(rel("ded")(S(action))) as [string, string, number, number][]).map(
      ([rule, fact, s, c]) => ({ rule, fact, s, c }),
    );
    if (deductions.length === 0) throw new Error(`PLN returned no Acceptable belief for ${action}`);
    deductions.sort((x, y) => RULE_ORDER.indexOf(x.rule) - RULE_ORDER.indexOf(y.rule));
    let tv: [number, number] = [deductions[0]!.s, deductions[0]!.c];
    for (let k = 1; k < deductions.length; k++) {
      const d = deductions[k]!;
      tv = db.evalJs(e(revS(tv[0], tv[1], d.s, d.c), revC(tv[1], d.c)))[0] as [number, number];
    }
    const ruleProofs = deductions.map((d) => `(rule-proof ${d.rule} ${d.fact})`);
    const proofTerm = ruleProofs.length > 1 ? `(merge/revision ${ruleProofs.join(" ")})` : ruleProofs[0]!;
    const proof = `(: ${proofTerm} (Acceptable ${action}) (STV ${tv[0]} ${tv[1]}))`;
    beliefs[action] = { strength: tv[0], confidence: tv[1], proof };
    rawOutputs.push(proof);
  }
  const program = [...ruleAtoms, ...factAtoms].map((a) => String(a)).join("\n");
  return { beliefs, program, rawOutputs };
}
