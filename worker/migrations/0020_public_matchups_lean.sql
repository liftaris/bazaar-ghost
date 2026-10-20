-- KAI-102: public_matchups carried every public_sources column through its window sort. Ranking only the columns the view
-- exposes halves the cost of every Matchup list; the view's columns and rows are unchanged.
DROP VIEW public_matchups;
CREATE VIEW public_matchups AS
WITH ranked AS (SELECT ps.matchup_id,ps.detection_id,ps.username,ps.confidence,ps.rank,ps.igd,ps.recorded_timestamp,
    row_number() OVER (PARTITION BY ps.matchup_id ORDER BY ps.confidence DESC,ps.rank IS NULL,ps.igd IS NULL,ps.indexed_at,ps.detection_id) AS display_rank,
    max(ps.indexed_at) OVER (PARTITION BY ps.matchup_id) AS latest_indexed_at
  FROM public_sources ps)
SELECT r.matchup_id,r.detection_id,r.username,r.confidence,r.rank,r.igd,r.recorded_timestamp,r.latest_indexed_at AS indexed_at,
  m.session_id,m.session_time
FROM ranked r JOIN matchups m ON m.id=r.matchup_id WHERE r.display_rank=1;
