import { array, maxLength, nullable, object, optional, picklist, pipe, regex, string } from 'valibot';

/** A complete first-login calendar batch, dated by the game server. Old bridges omit this optional observation. */
export const calendarSchema = optional(
  nullable(
    object({
      day: pipe(string(), regex(/^\d{4}-\d{2}-\d{2}$/)),
      items: pipe(
        array(
          object({
            title: pipe(string(), maxLength(160)),
            action: picklist(['start', 'end', 'personal_start', 'personal_end', 'reset', 'reset_soon']),
            when: pipe(string(), regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)),
          }),
        ),
        maxLength(32),
      ),
    }),
  ),
);
