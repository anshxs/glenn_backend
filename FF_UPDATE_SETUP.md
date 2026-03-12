# Free Fire Data Update - Secure Implementation

## Overview
Secure system to update Free Fire user data (FFUID, FF name, account creation date) via **Python backend** which calls the Next.js backend with JWT authentication. This prevents direct database manipulation and ensures data integrity.

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────────┐      ┌──────────────┐
│   Flutter   │─────▶│ Python API       │─────▶│ Glenn Backend   │─────▶│  Supabase    │
│     App     │      │ (ffuserinfo.app) │      │   (Vercel)      │      │  Database    │
└─────────────┘      └──────────────────┘      └─────────────────┘      └──────────────┘
     │                        │                         ▲
     │                        │                         │
     │                  Garena API                 JWT Token
     │                  (Fetch FF Data)           (Verification)
     └────────────────────────┘
```

**Flow:**
1. Flutter app calls Python API with `user_id`, `ffuid`, and `jwt_token`
2. Python API fetches FF data from Garena API (nickname, creation date, level)
3. Python API calls Next.js backend `/api/ff-update` with JWT token
4. Next.js backend verifies JWT and updates Supabase using service role key
5. Response flows back to Flutter app

## Setup Steps

### 1. Run SQL Migration

Execute the SQL migration in your Supabase SQL Editor:

```bash
# Location: glenn_backend/FF_UPDATE_MIGRATION.sql
```

This will:
- Add `ff_creation_date` column to `sensitive_userdata`
- Add `ff_level` column to `sensitive_userdata`
- Create RLS policy to block direct updates to these columns
- Add indexes for performance

**Verification:**
```sql
-- Check columns exist
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'sensitive_userdata' 
  AND column_name IN ('ff_creation_date', 'ff_level');

-- Check RLS policy exists
SELECT polname, polcmd, polroles 
FROM pg_policy 
WHERE polrelid = 'public.sensitive_userdata'::regclass
  AND polname = 'block_ff_data_anon_updates';
```

### 2. Deploy Backend API

The backend API is already created at:
```
glenn_backend/api/ff-update/route.ts
```

**API Endpoint:** `POST /api/ff-update`

**Required Headers:**
```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer <JWT_TOKEN>"
}
```

**Request Body:**
```json
{
  "user_id": "uuid-here",
  "ffuid": "1101432888",
  "ff_name": "Gεɴεʀᴀʟㅤㅤ",
  "ff_creation_date": "1560527366",
  "level": 67  // optional
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "FF data updated successfully",
  "data": {
    "user_id": "uuid-here",
    "ffuid": "1101432888",
    "ff_name": "Gεɴεʀᴀʟㅤㅤ",
    "ff_creation_date": "1560527366",
    "level": 67
  }
}
```

**Error Responses:**
- `401 Unauthorized` - Invalid or missing JWT token
- `403 Forbidden` - User trying to update someone else's data
- `404 Not Found` - User doesn't exist
- `409 Conflict` - FFUID already taken by another user
- `500 Internal Server Error` - Database error

### 3. Security Features

#### JWT Token Verification
- Every request must include valid Supabase JWT token
- Token is verified using `supabaseAdmin.auth.getUser(token)`
- User can only update their own data (user_id must match authenticated user)

#### RLS Policy Protection
```sql
CREATE POLICY "block_ff_data_anon_updates" 
ON public.sensitive_userdata
AS RESTRICTIVE
FOR UPDATE
TO anon, authenticated
USING (
  (OLD.ff_creation_date IS NOT DISTINCT FROM NEW.ff_creation_date) AND
  (OLD.ff_level IS NOT DISTINCT FROM NEW.ff_level)
);
```

This policy:
- Blocks any direct updates to `ff_creation_date` and `ff_level` columns
- Applies to both anon and authenticated roles
- Only backend API (using service role key) can update these columns

#### FFUID Uniqueness Check
- Prevents FFUID conflicts between users
- Allows updating own FFUID
- Blocks if FFUID already belongs to another user

### 4. Flutter Implementation

The Flutter app now calls the **Python API** which handles both fetching and updating:

**Service Method:**
```dart
// lib/services/ff_userinfo_service.dart
static Future<bool> fetchAndUpdateFFData({
  required String userId,
  required String ffuid,
}) async {
  final session = Supabase.instance.client.auth.currentSession;
  
  final response = await http.post(
    Uri.parse('https://ffuserinfo.vercel.app/fetch_and_update'),
    headers: {
      'Content-Type': 'application/json',
    },
    body: json.encode({
      'user_id': userId,
      'ffuid': ffuid,
      'jwt_token': session.accessToken,
    }),
  );
  
  return response.statusCode == 200;
}
```

**Usage in Onboarding:**
```dart
// One call does everything: fetch from Garena API and update database
await FFUserInfoService.fetchAndUpdateFFData(
  userId: userId,
  ffuid: ffuid,
);
```

### 5. Python API Implementation

**New Endpoint:** `POST /fetch_and_update`

**Request:**
```json
{
  "user_id": "uuid-here",
  "ffuid": "1101432888",
  "jwt_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**What it does:**
1. Validates input parameters
2. Fetches FF data from Garena API (nickname, creation date, level)
3. Calls Next.js backend `/api/ff-update` with JWT token
4. Returns success/error

**Success Response:**
```json
{
  "status": "success",
  "message": "FF data fetched and updated successfully",
  "data": {
    "ffuid": "1101432888",
    "ff_name": "Gεɴεʀᴀʟㅤㅤ",
    "ff_creation_date": "1560527366",
    "level": 67
  }
}
```

### 5. Testing

#### Test Complete Flow (Should Succeed)
```dart
// In Flutter app - this calls Python API which calls Next.js backend
final success = await FFUserInfoService.fetchAndUpdateFFData(
  userId: userId,
  ffuid: '1101432888',
);
// Expected: true
```

#### Test Direct Update (Should Fail - RLS Protection)
```dart
// This should fail due to RLS policy
await Supabase.instance.client
  .from('sensitive_userdata')
  .update({'ff_creation_date': '1560527366'})
  .eq('id', userId);
// Expected: Error or no rows updated
```

#### Test Python API Directly
```bash
curl -X POST https://ffuserinfo.vercel.app/fetch_and_update \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "your-user-id",
    "ffuid": "1101432888",
    "jwt_token": "your-jwt-token"
  }'
# Expected: 200 with success status
```

#### Test Backend API Unauthorized (Should Fail)
```bash
# Try to call backend directly without token
curl -X POST https://glenn-backend.vercel.app/api/ff-update \
  -H "Content-Type: application/json" \
  -d '{"user_id":"uuid","ffuid":"123","ff_name":"Test","ff_creation_date":"123"}'
# Expected: 401 Unauthorized
```

## Database Schema

### public_userdata
```sql
- ffuid TEXT (unique)
- ff_name TEXT
- (other columns...)
```

### sensitive_userdata
```sql
- ffuid TEXT (unique)
- ffname TEXT
- ff_creation_date TEXT  -- Protected by RLS
- ff_level INTEGER       -- Protected by RLS
- (other columns...)
```

## Security Checklist

- [x] JWT token verification on every request
- [x] User can only update their own data
- [x] RLS policy blocks direct column updates
- [x] FFUID uniqueness validation
- [x] Service role key required for updates
- [x] Error handling and logging
- [x] Input validation (numeric FFUID, required fields)
- [x] Rate limiting (via Vercel/backend)

## Troubleshooting

### "Failed to update FF data"
- Check JWT token is valid (user is logged in)
- Verify FFUID is valid and user exists in Free Fire
- Check Python API logs for Garena API errors
- Check Next.js backend logs for database update errors
- Verify user_id matches authenticated user

### Python API Returns Error
```bash
# Check Python API logs on Vercel
# Common errors:
# - GARENA_AUTH_FAILED: Garena account credentials expired
# - PLAYER_DATA_NOT_FOUND: Invalid FF UID
# - BACKEND_CONNECTION_FAILED: Cannot reach Next.js backend
# - BACKEND_UPDATE_FAILED: Backend returned error (check backend logs)
```

### RLS Policy Not Working
```sql
-- Verify policy exists
SELECT * FROM pg_policies 
WHERE tablename = 'sensitive_userdata' 
  AND policyname = 'block_ff_data_anon_updates';

-- Check if RLS is enabled
SELECT relname, relrowsecurity 
FROM pg_class 
WHERE relname = 'sensitive_userdata';
```

### Backend API Not Responding
- Check Vercel deployment status for both Python and Next.js
- Verify environment variables are set
- Check backend logs in Vercel dashboard
- Test backend endpoint directly with curl

## Environment Variables

### Flutter (.env)
```env
# No BACKEND_URL needed anymore - Python API is hardcoded
```

### Python API (glenn_ffuserinfo)
```python
# Hardcoded in app.py
GLENN_BACKEND_URL = "https://glenn-backend.vercel.app"
```

### Backend (glenn_backend - Vercel)
```env
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

## Additional Notes

- FF name supports Unicode characters (automatically parsed)
- Account creation date is Unix timestamp
- Level field is optional
- All updates are logged in backend console
- Frontend shows user-friendly error messages
