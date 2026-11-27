import assert from 'node:assert/strict'
import test from 'node:test'
import { formatWhen } from '../src/when.ts'
import { parseTimeZone } from '../src/owner.ts'

test('a timed event reads in the owner\'s zone, with the zone named', () => {
  // 17:00 UTC is 9am in Los Angeles in November (PST)...
  const at = new Date('2026-11-27T17:00:00Z')
  assert.equal(formatWhen(at, { dateTime: '2026-11-27T09:00:00-08:00' }, 'America/Los_Angeles'), 'Fri 2026-11-27 09:00 PST')
  // ...and 10am in July (PDT), so daylight saving is the zone's, not a fixed offset.
  assert.equal(formatWhen(new Date('2026-07-01T17:00:00Z'), undefined, 'America/Los_Angeles'), 'Wed 2026-07-01 10:00 PDT')
  assert.equal(formatWhen(at, undefined, 'UTC'), 'Fri 2026-11-27 17:00 UTC')
})

test('a late-evening event lands on its local date, not the UTC one', () => {
  assert.equal(formatWhen(new Date('2026-11-28T04:30:00Z'), undefined, 'America/Los_Angeles'), 'Fri 2026-11-27 20:30 PST')
})

test('an all-day event shows its date and "all day", unshifted by the zone', () => {
  // Stored as UTC midnight; converting it would read as 4pm the day before.
  const at = new Date('2026-11-28T00:00:00Z')
  assert.equal(formatWhen(at, { date: '2026-11-28' }, 'America/Los_Angeles'), 'Sat 2026-11-28, all day')
})

test('the time zone setting accepts IANA names and refuses typos', () => {
  assert.equal(parseTimeZone('America/Los_Angeles'), 'America/Los_Angeles')
  assert.equal(parseTimeZone(' Europe/London '), 'Europe/London')
  assert.ok(parseTimeZone(undefined))
  assert.throws(() => parseTimeZone('America/Los_Angles'), /not a known time zone/)
})
