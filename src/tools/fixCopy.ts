/**
 * Sentences the "Get this fix" tools share, so the owner-confirms rule
 * (owner decision, 2026-11-03: a member's assistant may confirm only facts
 * the owner was shown and agreed to, sending back exactly the `seen` it was
 * handed) is worded once.
 */

/** The rule itself, for a message that already says which tool confirms. */
export const OWNER_ONLY =
  "Only the owner confirms: never confirm facts on their behalf or without asking them, and send `seen` back " +
  "exactly as given here, unchanged.";

export const OWNER_CONFIRMS =
  "Show the owner each fact and ask them to confirm or correct it. Only the owner confirms: never confirm facts on " +
  "their behalf or without asking them. Then call confirm_facts with their answers as `facts` (the business name " +
  "under \"name\") and `seen` exactly as given here, unchanged.";

export const NOTHING_TO_CONFIRM =
  "The site hasn't been read yet (or not this week), so there is nothing to confirm: its next weekly check reads " +
  "it. Ask again after that.";

/** For an answer whose own sentence already says the site wasn't read. */
export const AFTER_THE_WEEKLY_CHECK = "Ask for it again after the site's next weekly check reads it.";
