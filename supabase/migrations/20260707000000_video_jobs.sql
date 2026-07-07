-- =====================================================================
-- video_jobs: asynchronous AI video generation jobs.
--
-- Videos are rendered by an external MoneyPrinterTurbo microservice
-- (Python/FastAPI + ffmpeg) — Supabase Edge Functions cannot run that
-- workload. The `generate-video` Edge Function creates a row here
-- (status=pending), submits the job to MoneyPrinterTurbo, stores its
-- task id, and returns immediately. `video-status` then polls the
-- microservice and, when the render is done, downloads the file, uploads
-- it to Supabase Storage (user-assets) and sets status=done + video_url.
--
-- No external API calls live here — only storage + RLS. Inserts/updates
-- come from the edge functions using the service role (which bypasses
-- RLS), so we deliberately do NOT expose an INSERT policy to end users.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.video_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Optional link to the post this video belongs to (for publishing later).
  post_id UUID REFERENCES public.posts(id) ON DELETE SET NULL,
  provider TEXT NOT NULL DEFAULT 'moneyprinterturbo',
  -- pending  : row created, not yet submitted / just submitted
  -- processing: accepted by MoneyPrinterTurbo, rendering
  -- done     : rendered + uploaded to Storage (video_url set)
  -- failed   : generation or upload failed (error_message set)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  -- MoneyPrinterTurbo task id (data.task_id) used to poll GET /tasks/{id}.
  external_task_id TEXT,
  -- Human-friendly copies of the main request parameters (for list display).
  subject TEXT,
  aspect TEXT,                     -- '9:16' | '16:9' | '1:1'
  -- Full generation parameters actually sent to MoneyPrinterTurbo.
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  progress INTEGER NOT NULL DEFAULT 0,   -- 0..100
  video_url TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_user_status
  ON public.video_jobs (user_id, status, created_at DESC);
-- Lets a cron poller efficiently find still-running jobs to refresh.
CREATE INDEX IF NOT EXISTS idx_video_jobs_active
  ON public.video_jobs (status)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.video_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_jobs' AND policyname='Users can view their own video jobs') THEN
    CREATE POLICY "Users can view their own video jobs"
      ON public.video_jobs FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_jobs' AND policyname='Users can update their own video jobs') THEN
    CREATE POLICY "Users can update their own video jobs"
      ON public.video_jobs FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='video_jobs' AND policyname='Users can delete their own video jobs') THEN
    CREATE POLICY "Users can delete their own video jobs"
      ON public.video_jobs FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

DROP TRIGGER IF EXISTS update_video_jobs_updated_at ON public.video_jobs;
CREATE TRIGGER update_video_jobs_updated_at
  BEFORE UPDATE ON public.video_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Optional: expose the table over Supabase Realtime so the dashboard can
-- subscribe to job progress instead of (or in addition to) polling. Guarded
-- so the migration still applies on stacks without the publication.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'video_jobs'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.video_jobs;
    END IF;
  END IF;
END $$;
