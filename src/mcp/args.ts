import { z } from 'zod'

/**
 * A whole-number argument that also accepts the number as text.
 *
 * A client holding a tool schema from before a parameter existed passes that
 * parameter through untyped, and it arrives as "60" rather than 60. Strict
 * validation then failed the call (about ten a month, measured 2026-11-21) for
 * a value that was never ambiguous. The published schema is still an integer.
 */
export const intArg = (min: number, max?: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v),
    max === undefined ? z.number().int().min(min) : z.number().int().min(min).max(max),
  )
