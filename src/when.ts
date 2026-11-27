/**
 * How a calendar event's time reads in `brief` and `upcoming`.
 *
 * Times are stored in UTC, and printing them that way made a 9am Pacific
 * meeting read as "17:00". They are shown in the owner's zone, with the zone
 * named so the reader never has to guess.
 *
 * An all-day event has a date and no time. Google gives it as `start.date`, and
 * it is stored as UTC midnight of that date, so converting it to a zone would
 * shift it to the evening before. It is printed from the date itself instead.
 */
import { OWNER_TIMEZONE } from './owner.ts'

export interface EventStart {
  date?: string
  dateTime?: string
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function formatWhen(at: Date, start?: EventStart, timeZone: string = OWNER_TIMEZONE): string {
  if (start?.date && !start.dateTime) {
    const day = new Date(`${start.date}T00:00:00Z`)
    return `${WEEKDAYS[day.getUTCDay()]} ${start.date}, all day`
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  )
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`
}
