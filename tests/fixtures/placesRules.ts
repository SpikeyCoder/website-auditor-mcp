/** What a reader must be told about `places`, matched with or without backticks so every surface is held to the same rules. */
export const PLACES_RULES: Array<[string, RegExp]> = [
  ["names the field", /`?places`?:/],
  ["separate from the citywide score", /measured separately from the citywide score, not as a breakdown of it/],
  ["null is not measured, never zero, never absent there", /named: null`?[^;]*not measured[^;]*not zero and not evidence the business is missing there/],
  ["partial", /partial: true`? means only part of the answers were measured/],
  ["places_not_shown", /`?places_not_shown`? means more areas exist than are listed/],
  ["summary already has the sentences", /already in `?summary`?/],
  ["absent is not a failure", /absent `?places`? means no area results[^.]*not a failure/],
];
