-- Public Matchup counts per Streamer. Counting them ranks every public Matchup, so the unfiltered
-- Streamer list reads this table, refreshed by the scheduler and by a read that finds it stale.
CREATE TABLE streamer_matchup_counts(streamer_id INTEGER PRIMARY KEY, n INTEGER NOT NULL CHECK(n>0));
CREATE TABLE streamer_matchup_counts_state(id INTEGER PRIMARY KEY CHECK(id=1), computed_at INTEGER NOT NULL);
