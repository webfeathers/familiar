/**
 * Who this deployment belongs to.
 *
 * Grimalkin is single-user, but the code names no one: every owner-specific value
 * comes from the environment, and the defaults are neutral so a fresh install
 * works before any of it is set.
 *
 *   PCL_SELF         the owner's name, as their entity is (or will be) named
 *   PCL_SELF_EMAILS  the owner's own addresses or domains, comma-separated
 *                    (`me@example.com`, `example.com` or `@example.com`)
 */

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined

/** Whose preferences `how_i_work` and `note_preference` are about. */
export const OWNER_NAME = env('PCL_SELF') ?? 'Owner'

export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

/** The owner's own addresses and domains, left out of "who is this meeting with". */
export const OWNER_EMAILS: readonly string[] = parseEmailList(env('PCL_SELF_EMAILS'))

/**
 * Is this one of the owner's own addresses? An entry with an `@` matches that
 * address exactly; a bare domain matches it and its subdomains.
 */
export function isOwnerEmail(email: string, owned: readonly string[] = OWNER_EMAILS): boolean {
  const e = email.trim().toLowerCase()
  const domain = e.slice(e.lastIndexOf('@') + 1)
  return owned.some((o) => (o.includes('@') ? e === o : domain === o || domain.endsWith(`.${o}`)))
}
