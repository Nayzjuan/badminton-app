-- ============================================================
-- 2026-07-02: rename the seeded Legacy club → "CHILLAX"
-- ============================================================
-- Display NAME only — the slug stays 'legacy' so existing /c/legacy links and
-- printed QR codes keep resolving. Applied to prod via SQL during the session;
-- persisted here for tracking. Idempotent (no-op once renamed).
-- ============================================================

UPDATE public.clubs
SET name = 'CHILLAX'
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND name <> 'CHILLAX';
