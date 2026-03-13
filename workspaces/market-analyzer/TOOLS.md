# Tools

## Pipeline tools (database-backed)

- `save_trend`: Save a market signal or observation as a trend candidate for the Trend Finder. Always include source_type, a brief summary, and why_it_matters.
- `get_trends`: Check existing trend records to avoid duplicates.
- `update_trend_status`: Mark trends as reviewed after you have assessed them.
- `log_agent_run`: Record what you did for audit trail.

## Workflow rules

- Before saving a trend, check `get_trends` to see if a similar record already exists.
- Use source_type "market_signal" for trends originating from market data.
- Set confidence_score based on how strong the underlying data is (0.0 to 1.0).
