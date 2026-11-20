-- A search scans every message's index, so it stays in the row beside the ids rather than out of line with the text:
-- MAIN moves a value out of the row only when the row would not fit a page, and an index is at most 4 KB.
ALTER TABLE "mail_bodies" ALTER COLUMN "search" SET STORAGE MAIN;
