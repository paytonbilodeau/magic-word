-- How a matched join came about (src/joins.ts joinPath): set = a real conversation and a pitch or link before the join,
-- asked = they asked to join and we handed over the link, self = joined without being pitched.
ALTER TABLE joins ADD COLUMN path TEXT;
