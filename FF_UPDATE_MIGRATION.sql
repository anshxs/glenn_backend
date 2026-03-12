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

-- Drop existing policies/triggers if they exist
DROP POLICY IF EXISTS "block_ff_data_anon_updates" ON public.sensitive_userdata;
DROP TRIGGER IF EXISTS prevent_ff_data_update_trigger ON public.sensitive_userdata;
DROP FUNCTION IF EXISTS prevent_ff_data_update();

-- Create a trigger function to prevent updates to ff_creation_date and ff_level
-- unless it's from the service role
CREATE OR REPLACE FUNCTION prevent_ff_data_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if current role is service_role (backend API)
  -- Service role bypasses this restriction
  IF current_user IN ('service_role', 'postgres') THEN
    RETURN NEW;
  END IF;
  
  -- For anon/authenticated users, prevent changes to ff_creation_date and ff_level
  IF (OLD.ff_creation_date IS DISTINCT FROM NEW.ff_creation_date) THEN
    RAISE EXCEPTION 'Direct updates to ff_creation_date are not allowed. Use the API endpoint.';
  END IF;
  
  IF (OLD.ff_level IS DISTINCT FROM NEW.ff_level) THEN
    RAISE EXCEPTION 'Direct updates to ff_level are not allowed. Use the API endpoint.';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to enforce the column update restriction
CREATE TRIGGER prevent_ff_data_update_trigger
  BEFORE UPDATE ON public.sensitive_userdata
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ff_data_update();

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
