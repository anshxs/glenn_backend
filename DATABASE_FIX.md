# Database Trigger Error Fix

## Problem
Error: `column "registration_status" does not exist`

This error is caused by a database trigger trying to access a non-existent column.

## Solution

### Option 1: Add Missing Column (Recommended)

Run this SQL in your Supabase SQL Editor:

```sql
-- Add registration_status column to tournament_participants table
ALTER TABLE public.tournament_participants 
ADD COLUMN registration_status TEXT DEFAULT 'registered';

-- Add constraint for valid values
ALTER TABLE public.tournament_participants
ADD CONSTRAINT tournament_participants_registration_status_check 
CHECK (registration_status = ANY (ARRAY['registered'::text, 'cancelled'::text, 'completed'::text]));
```

### Option 2: Fix the Trigger

If you have a custom trigger that references `registration_status`, update it to use the correct column name.

Check these triggers in Supabase (Database > Functions):
- `prevent_duplicate_registration`
- `decrease_tournament_slots`
- `enforce_before_operation`
- `increase_tournament_slots`
- `prevent_fee_tampering`

Look for any reference to `registration_status` and change it to `check_in_status` or remove it.

### How to Check Triggers

1. Go to Supabase Dashboard
2. Navigate to **Database** > **Functions**
3. Search for `registration_status`
4. Update or remove the problematic code

## Quick Fix (Recommended)

Run this in Supabase SQL Editor:

```sql
-- Add the column that the trigger expects
ALTER TABLE public.tournament_participants 
ADD COLUMN IF NOT EXISTS registration_status TEXT DEFAULT 'registered';
```

After running this SQL command, try registering again from your Flutter app.
