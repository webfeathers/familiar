/**
 * Lexical restatement detection, shared by preferences and facts.
 *
 * Extracted from `preferences.ts` (unchanged behaviour there) so `remember`
 * can use the same notion of "this is the same thing said again". Kept
 * dependency-free and deliberately crude: it exists to catch a reworded
 * restatement, not to understand meaning.
 *
 * KNOW WHAT THIS CANNOT DO. Jaccard over content words catches a RESTATEMENT
 * ("prefers conclusions first" / "prefers the conclusion stated before the
 * reasoning"). It does NOT catch a CONTRADICTION, because a correction rarely
 * shares vocabulary with the thing it corrects. Measured on the real case that
 * motivated this file: "leads the Support team" against "is Sr. Director,
 * Customer Success AI and Operations ... and no longer leads Support" scores
 * about 0.08 — two shared tokens against a union of twenty-five. No threshold
 * that catches that is safe, because at 0.08 everything matches everything.
 *
 * That is why `remember` takes an explicit `supersedes` argument. Similarity
 * handles the cheap half (an identical fact written twice); the caller handles
 * the half that needs judgement.
 */

/** Cheap normalisation for match-checking only — never stored. */
const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Crude singularisation. Without it "conclusions" and "conclusion" are distinct
 * tokens, which is enough on its own to make a restatement look new.
 */
const stem = (w: string) =>
  w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w

/** Stopwords carry no signal but inflate the union, deflating every score. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'than', 'then', 'when', 'over',
  'into', 'from', 'they', 'them', 'their', 'been', 'being', 'have', 'having',
  'rather', 'instead', 'about', 'stated', 'state',
])

export const tokens = (s: string) =>
  new Set(
    norm(s)
      .split(' ')
      .filter((w) => w.length > 3 && !STOP.has(w))
      .map(stem),
  )

/**
 * Jaccard over stemmed content words. No dependency, good enough to spot a
 * restatement without collapsing genuinely different statements.
 */
export function similarity(a: string, b: string): number {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / new Set([...A, ...B]).size
}

/**
 * Preferences merge at 0.55 — see the note in `preferences.ts` for why erring
 * low is the cheap direction there.
 */
export const RESTATEMENT_THRESHOLD = 0.55

/**
 * Facts merge higher, because the cost is reversed. A wrong preference merge is
 * visible in `how_i_work` and costs a nuance; a wrong FACT merge silently
 * invalidates something true and the only trace is an `invalidated_by` nobody
 * reads. So this only fires on near-identical restatements, and everything
 * short of that is left for the caller to declare with `supersedes`.
 */
export const FACT_RESTATEMENT_THRESHOLD = 0.8
