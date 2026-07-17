-- Bot findings carry no provider id, and Postgres unique constraints ignore
-- NULLs, so ON CONFLICT (provider_id) never fired for them and every re-run of
-- a review re-inserted the same rows. Collapse existing duplicates (keep the
-- oldest), then enforce content uniqueness for id-less rows.

DELETE FROM discussions dup
USING discussions keep
WHERE dup.provider_id IS NULL
  AND keep.provider_id IS NULL
  AND dup.id > keep.id
  AND dup.repo = keep.repo
  AND dup.source = keep.source
  AND dup.pr_number IS NOT DISTINCT FROM keep.pr_number
  AND dup.file_path IS NOT DISTINCT FROM keep.file_path
  AND md5(dup.body) = md5(keep.body);

CREATE UNIQUE INDEX IF NOT EXISTS discussions_no_provider_id_dedup_idx
  ON discussions (repo, source, coalesce(pr_number, -1), coalesce(file_path, ''), md5(body))
  WHERE provider_id IS NULL;
