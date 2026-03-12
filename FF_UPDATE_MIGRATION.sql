-- Migration: Add ff_creation_date and ff_level columns, and create RLS policy

-- 1. Add ff_creation_date column to sensitive_userdata (if not exists)
ALTER TABLE public.sensitive_userdata 
ADD COLUMN IF NOT EXISTS ff_creation_date TEXT NULL;

-- 2. Add ff_level column to sensitive_userdata (if not exists)
ALTER TABLE public.sensitive_userdata 
ADD COLUMN IF NOT EXISTS ff_level INTEGER NULL;

-- 3. Add comment to columns for documentation
COMMENT ON COLUMN public.sensitive_userdata.ff_creation_date IS 'Free Fire account creation date (Unix timestamp). Only updatable via backend API.';
COMMENT ON COLUMN public.sensitive_userdata.ff_level IS 'Free Fire account level. Only updatable via backend API.';

-- 4. Create RLS policy to block direct updates to ff_creation_date and ff_level from anon key
-- First, enable RLS if not already enabled
ALTER TABLE public.sensitive_userdata ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if it exists
DROP POLICY IF EXISTS "block_ff_data_anon_updates" ON public.sensitive_userdata;

-- Create policy to block updates to ff_creation_date and ff_level columns via anon key
-- This policy checks if the old values are being changed
CREATE POLICY "block_ff_data_anon_updates" 
ON public.sensitive_userdata
AS RESTRICTIVE
FOR UPDATE
TO anon, authenticated
USING (
  -- Block updates if ff_creation_date or ff_level is being changed
  -- The policy will fail if these columns are different between OLD and NEW
  (
    (OLD.ff_creation_date IS NOT DISTINCT FROM NEW.ff_creation_date) AND
    (OLD.ff_level IS NOT DISTINCT FROM NEW.ff_level)
  )
);

-- 5. Add index for better query performance on ff_creation_date
CREATE INDEX IF NOT EXISTS idx_sensitive_userdata_ff_creation_date 
ON public.sensitive_userdata(ff_creation_date) 
WHERE ff_creation_date IS NOT NULL;

-- 6. Verify the changes
-- You can run these queries to verify:
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'sensitive_userdata' AND column_name IN ('ff_creation_date', 'ff_level');

-- SELECT polname, polcmd, polroles, polpermissive 
-- FROM pg_policy 
-- WHERE polrelid = 'public.sensitive_userdata'::regclass;
