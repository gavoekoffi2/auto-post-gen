-- Minimal stand-in for the parts of a Supabase project that live OUTSIDE
-- supabase/migrations (auth, storage, the built-in roles). It exists so the
-- migrations can be applied to a plain Postgres in CI and proved to work
-- before they are pointed at production — the deploy re-applies every
-- migration at or after MIGRATION_CUTOFF on each push, and until now nothing
-- checked that they still apply, or that re-applying them is safe.
--
-- This is NOT a reproduction of Supabase. It defines only what the migrations
-- reference. If a migration starts using another auth/storage object, add it
-- here rather than weakening the migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;

DO $$ BEGIN CREATE ROLE anon NOLOGIN;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
  raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
  banned_until timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- auth.uid() reads the JWT subject; tests set request.jwt.claim.sub to
-- impersonate a user and exercise the RLS policies for real.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('request.jwt.claim.role', true), 'anon') $$;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY,
  name text,
  public boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text,
  owner uuid,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT string_to_array(name, '/') $$;
