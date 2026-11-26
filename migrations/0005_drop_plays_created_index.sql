-- The 24h counter that used this index is gone; it only added a row write per pull.
DROP INDEX IF EXISTS plays_created_at;
