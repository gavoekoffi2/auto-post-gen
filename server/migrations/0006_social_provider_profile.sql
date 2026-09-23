-- Keep the provider tenant mapping even before OAuth completes or after the
-- last account is removed. Never infer it from legacy/default account rows.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS provider_profile_key text;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_provider_profile_key_unique
  ON profiles (provider_profile_key) WHERE provider_profile_key IS NOT NULL;
