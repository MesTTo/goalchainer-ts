// Shared helpers for driving the @metta-ts engine through the typed eDSL.
// The reasoning math runs on the interpreter; these are the small pieces the
// engines reuse (min/abs as MeTTa, and reading a single numeric result).

import { mettaDB, MettaDB, iff, le, ge, sub, type Term } from "@metta-ts/edsl";
import { GroundedAtom, type Atom } from "@metta-ts/hyperon";
import { gfloat } from "@metta-ts/core";

/** A Float-typed atom. ValueAtom grounds an integer-valued number as an Int, and
 * the engine's `/` floors two Ints, so a float operand is needed for true division. */
export const flt = (n: number): Atom => new GroundedAtom(gfloat(n));

/** (min a b) on the engine: there is no stdlib min, so branch on <=. */
export const mmin = (a: Term, b: Term): Term => iff(le(a, b), a, b);

/** (abs x) on the engine. */
export const mabs = (x: Term): Term => iff(ge(x, 0), x, sub(0, x));

/** Evaluate a term to a single number on the engine. */
export function num(db: MettaDB, term: Term): number {
  return db.evalJs(term)[0] as number;
}

export { mettaDB, type MettaDB };
