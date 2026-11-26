-- Running totals, so the page never has to COUNT(*) a growing table (D1 bills rows read).
CREATE TABLE counters (
	name TEXT PRIMARY KEY,
	value INTEGER NOT NULL
);

INSERT INTO counters (name, value) SELECT 'pulls', COUNT(*) FROM plays;
