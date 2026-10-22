-- REVIEW ONLY. Not executed by the Node migration runner.
-- Requires owner approval, a database backup, and review of existing clients.
-- This retires the old browser-password writer, including its article editor.
BEGIN;
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT p.oid::regprocedure signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('verify_admin_password','change_admin_password','update_announcement',
       'get_db_schema_for_ai','save_article_v2','add_feedback','delete_feedback')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',item.signature);
  END LOOP;
  FOR item IN
    SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND tablename IN ('feedbacks','articles','article_tags','tags','site_settings','announcements')
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM PUBLIC, anon, authenticated',item.tablename);
  END LOOP;
END $$;
-- Restrictive policies preserve reads and other buckets, but prevent legacy
-- browser credentials from writing these two old public buckets.
DROP POLICY IF EXISTS cms_retired_bucket_insert ON storage.objects;
CREATE POLICY cms_retired_bucket_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id NOT IN ('feedback_images','article_images'));
DROP POLICY IF EXISTS cms_retired_bucket_update ON storage.objects;
CREATE POLICY cms_retired_bucket_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon, authenticated
  USING (bucket_id NOT IN ('feedback_images','article_images')) WITH CHECK (bucket_id NOT IN ('feedback_images','article_images'));
DROP POLICY IF EXISTS cms_retired_bucket_delete ON storage.objects;
CREATE POLICY cms_retired_bucket_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon, authenticated
  USING (bucket_id NOT IN ('feedback_images','article_images'));
COMMIT;
