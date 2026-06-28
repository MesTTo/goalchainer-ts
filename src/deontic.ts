// Derive each action's deontic status with a defeasible-deontic micro-engine on
// @metta-ts, driven through the typed eDSL. Ports goal_chainer/deontic_engine.py.
//
// The request's evidence becomes a theory of `given` facts and defeasible
// `normally` rules (must / may / forbidden heads), built as typed atoms and added
// to the engine. A `normally` rule fires its deontic head when its body is a
// `given` fact; the firing runs as `match` on the interpreter and returns typed
// rows. The F>O>P dominance fold stays in TypeScript (it is selection, not math).

import { type Term, type Atom, rel, S, v, matchSelf } from "@metta-ts/edsl";
import { mettaDB } from "./engine.js";
import type { IncidentEvidence } from "./evidence.js";
import { privacyAtStake } from "./evidence.js";

export const ACTION_ORDER = [
  "publish_raw_log",
  "publish_redacted_summary",
  "hold_external_update",
] as const;

const MODE_TO_STATUS: Record<string, string> = { forbidden: "forbidden", must: "obligated", may: "permitted" };
const STATUS_RANK: Record<string, number> = {
  forbidden: 3,
  obligated: 2,
  permitted: 1,
  unregulated: 0,
};

export interface DeonticResult {
  statusByAction: Record<string, string>;
  theory: string;
  conclusions: string;
}

export function deonticStatus(result: DeonticResult, actionId: string): string {
  return result.statusByAction[actionId] ?? "unregulated";
}

const given = (x: Term): Atom => rel("given")(x);
const normally = (name: string, body: Term, head: Term): Atom => rel("normally")(S(name), body, head);

/** Project the evidence into the defeasible-deontic theory as typed atoms. */
export function theoryAtoms(evidence: IncidentEvidence): Atom[] {
  const a = S.publish_raw_log;
  const r = S.publish_redacted_summary;
  const h = S.hold_external_update;
  const atoms: Atom[] = [];
  if (privacyAtStake(evidence)) {
    atoms.push(given(rel("risky")(a)), normally("rRawForbid", rel("risky")(a), rel("forbidden")(a)));
  } else {
    atoms.push(given(rel("safe")(a)), normally("rRawPermit", rel("safe")(a), rel("may")(a)));
  }
  atoms.push(given(rel("protects")(r)));
  if (evidence.factsReady) {
    atoms.push(normally("rRedOblige", rel("protects")(r), rel("must")(r)));
  } else {
    atoms.push(normally("rRedPermit", rel("protects")(r), rel("may")(r)));
  }
  if (!evidence.factsReady) {
    atoms.push(given(rel("factsUnready")()), normally("rHoldOblige", rel("factsUnready")(), rel("must")(h)));
  } else {
    atoms.push(given(rel("may")(h)));
  }
  return atoms;
}

/** The theory's MeTTa source, for the report (one atom per line). */
export function buildTheory(evidence: IncidentEvidence): string {
  return theoryAtoms(evidence).map((atom) => String(atom)).join("\n") + "\n";
}

export function deriveDeontic(evidence: IncidentEvidence): DeonticResult {
  const db = mettaDB();
  const atoms = theoryAtoms(evidence);
  db.add(...atoms);

  // A normally-rule fires its head when its body is a given fact; directly-given
  // deontic literals hold as themselves. Each clause adds a way to derive deon-lit.
  db.rule(rel("deon-lit")(), matchSelf(rel("normally")(v("n"), v("b"), v("h")), matchSelf(rel("given")(v("b")), v("h"))));
  for (const mode of ["forbidden", "may", "must"]) {
    db.rule(rel("deon-lit")(), matchSelf(rel("given")(rel(mode)(v("a"))), rel(mode)(v("a"))));
  }
  const lits = db.evalJs(rel("deon-lit")()) as string[][];

  const statusByAction: Record<string, string> = {};
  for (const lit of lits) {
    const [mode, action] = lit;
    if (mode === undefined || action === undefined) continue;
    const candidate = MODE_TO_STATUS[mode];
    if (candidate === undefined) continue;
    if ((STATUS_RANK[candidate] ?? 0) > (STATUS_RANK[statusByAction[action] ?? "unregulated"] ?? 0)) {
      statusByAction[action] = candidate;
    }
  }
  for (const actionId of ACTION_ORDER) {
    if (!(actionId in statusByAction)) statusByAction[actionId] = "unregulated";
  }
  const conclusions = "(" + lits.map(([m, ac]) => `(${m} ${ac})`).join(" ") + ")";
  return { statusByAction, theory: buildTheory(evidence), conclusions };
}
