/** What a reader must be told about `places`, matched with or without backticks so each surface is held to the same rules. */
export const PLACES_RULES: Array<[string, RegExp]> = [
  ["names the field", /(^|[\s`])places`?:/],
  ["separate from the citywide score", /measured separately from the citywide score, not as a breakdown of it/],
  ["null is not measured, never zero, never absent there", /named: null[\s\S]{0,120}?not measured[\s\S]{0,120}?not zero and not evidence the business is missing there/],
  ["partial", /partial: true`? means only part of the answers were measured/],
  ["places_not_shown", /`?places_not_shown`? means more areas exist than are listed/],
  ["summary already has the sentences", /already in `?summary`?/],
  ["absent is not a failure", /absent `?places`? means no area results[^.]*not a failure/],
];

/** The README row is a table cell in its own words: the rules a reader can get wrong, not the exact sentence. */
export const PLACES_README_RULES: Array<[string, RegExp]> = [
  ["both not-measured states", /`not_measured` or `not_measured_this_week` with `named: null`/],
  ["never zero", /never 0/],
  ["separate from the citywide score", /separately from the citywide score/],
  ["places_not_shown", /`places_not_shown`/],
  ["partial", /`partial: true`/],
  ["absent is not a failure", /absent[^.]*not a failure/],
];
