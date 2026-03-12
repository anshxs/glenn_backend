# Free Fire Data Update - Secure Implementation

## Overview
Secure system to update Free Fire user data (FFUID, FF name, account creation date) via backend API with JWT authentication. Prevents direct database manipulation via anon key.

## Architecture

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────────┐      ┌──────────────┐
│   Flutter   │─────▶│ FF Info API      │─────▶│ Glenn Backend   │─────▶│  Supabase    │
│     App     │      │ (ffuserinfo.app) │      │   (Vercel)      │      │  Database    │
└─────────────┘      └──────────────────┘      └─────────────────┘      └──────────────┘
     │                                                  │
     │                  JWT Token                       │
     └──────────────────────────────────────────────────┘
```

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

The Flutter app now calls the backend API instead of directly updating Supabase:

**Service Method:**
```dart
// lib/services/ff_userinfo_service.dart
static Future<bool> updateFFDataViaBackend({
  required String userId,
  required String ffuid,
  required String ffName,
  required String ffCreationDate,
  int? level,
}) async {
  final session = Supabase.instance.client.auth.currentSession;
  
  final response = await http.post(
    Uri.parse('$backendUrl/api/ff-update'),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ${session.accessToken}',
    },
    body: json.encode({
      'user_id': userId,
      'ffuid': ffuid,
      'ff_name': ffName,
      'ff_creation_date': ffCreationDate,
      if (level != null) 'level': level,
    }),
  );
  
  return response.statusCode == 200;
}
```

**Usage in Onboarding:**
```dart
// Fetch FF data from API
final userInfo = await FFUserInfoService.fetchUserInfo(ffuid);

// Update via backend (secure)
await FFUserInfoService.updateFFDataViaBackend(
  userId: userId,
  ffuid: ffuid,
  ffName: userInfo['nickname'],
  ffCreationDate: userInfo['created_at'],
);
```

### 5. Testing

#### Test Direct Update (Should Fail)
```dart
// This should fail due to RLS policy
await Supabase.instance.client
  .from('sensitive_userdata')
  .update({'ff_creation_date': '1560527366'})
  .eq('id', userId);
// Expected: Error or no rows updated
```

#### Test Backend Update (Should Succeed)
```dart
// This should succeed
final success = await FFUserInfoService.updateFFDataViaBackend(
  userId: userId,
  ffuid: '1101432888',
  ffName: 'TestUser',
  ffCreationDate: '1560527366',
);
// Expected: true
```

#### Test Unauthorized Access (Should Fail)
```bash
# Try to update without token
curl -X POST https://glenn-backend.vercel.app/api/ff-update \
  -H "Content-Type: application/json" \
  -d '{"user_id":"uuid","ffuid":"123","ff_name":"Test","ff_creation_date":"123"}'
# Expected: 401 Unauthorized
```

#### Test Wrong User (Should Fail)
```dart
// Try to update another user's data (should fail with 403)
await FFUserInfoService.updateFFDataViaBackend(
  userId: 'different-user-id',  // Not your ID
  ffuid: '123',
  ffName: 'Test',
  ffCreationDate: '123',
);
// Expected: false (403 Forbidden)
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
- Check JWT token is valid
- Verify user_id matches authenticated user
- Check FFUID format (must be numeric)
- Check backend logs for detailed error

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
- Check Vercel deployment status
- Verify environment variables are set:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
- Check backend logs in Vercel dashboard

## Environment Variables

### Flutter (.env)
```env
BACKEND_URL=https://glenn-backend.vercel.app
```

### Backend (Vercel)
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
