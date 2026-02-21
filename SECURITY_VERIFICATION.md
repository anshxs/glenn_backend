# Security Verification Checklist

## 🔐 Service Role Key Protection

### ✅ What's Already Protected:

1. **Environment Variables**
   - `SUPABASE_SERVICE_ROLE_KEY` is in `.env.local` (server-side only)
   - NOT prefixed with `NEXT_PUBLIC_` (would expose to client)
   - `.env*` files are in `.gitignore`
   - Never committed to Git

2. **Server-Side Only Usage**
   - Service role key only used in `/lib/supabase.ts`
   - Only imported in API routes (`/app/api/*`)
   - API routes run on server (Node.js), not in browser
   - Never sent in HTTP responses or headers

3. **Network Traffic**
   - Burp Suite/Charles Proxy **CANNOT** see service role key
   - Only the JWT token (user's authentication) is sent in requests
   - Service role key never leaves the server

### 🛡️ How It Works:

```
Client (Burp Suite can see)          Server (Hidden from Burp Suite)
┌─────────────────────┐              ┌──────────────────────┐
│  Flutter App        │              │  Next.js API Routes  │
│                     │              │                      │
│  JWT Token ────────────────────────>  Validates Token    │
│  (Bearer xxx)       │  HTTPS       │                      │
│                     │              │  Uses Service Role   │
│                     │              │  Key (HIDDEN)        │
│                     │              │                      │
│  Response Data  <─────────────────────  DB Query         │
└─────────────────────┘              └──────────────────────┘
```

**What Burp Suite Sees:**
- ✅ Request URL: `POST /api/participate`
- ✅ Headers: `Authorization: Bearer eyJhbGc...` (user's JWT)
- ✅ Request Body: `{ tournament_id: "...", ... }`
- ✅ Response: `{ success: true, data: { ... } }`

**What Burp Suite CANNOT See:**
- ❌ `SUPABASE_SERVICE_ROLE_KEY`
- ❌ Server-side environment variables
- ❌ Internal server logic
- ❌ Database credentials

## 🔍 Quick Security Audit

Run these checks to verify your security:

### 1. Verify Environment Variables

```bash
# In your project root
cat .gitignore | grep "\.env"
# Should show: .env*

# Check that .env.local is NOT tracked
git ls-files | grep ".env"
# Should return empty (no .env files tracked)
```

### 2. Check for Exposed Secrets

```bash
# Search for any accidental logging of secrets
grep -r "SUPABASE_SERVICE_ROLE_KEY" app/ --include="*.ts"
# Should return empty (key not used in API routes directly)

grep -r "console.log.*process.env" app/ --include="*.ts"
# Should return empty (no env vars logged)
```

### 3. Verify Next.js Configuration

```bash
# Check that service role key is NOT in next.config.ts
cat next.config.ts | grep "SUPABASE_SERVICE_ROLE_KEY"
# Should return empty
```

### 4. Test with Network Inspector

1. Open your Flutter app
2. Open Burp Suite / Charles Proxy / Browser DevTools
3. Make API requests to your backend
4. **Verify you ONLY see:**
   - User's JWT token in `Authorization` header
   - Request/response data
   - Public API endpoints

5. **Verify you DON'T see:**
   - Service role key
   - Database passwords
   - Any environment variables

## 🚨 Common Security Mistakes to Avoid

### ❌ DON'T Do This:

```typescript
// BAD: Prefixing with NEXT_PUBLIC_ exposes to client
const key = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY;

// BAD: Logging environment variables
console.log('Service role key:', process.env.SUPABASE_SERVICE_ROLE_KEY);

// BAD: Sending service role in response
return NextResponse.json({
  success: true,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY // NEVER DO THIS
});

// BAD: Using service role key in client-side code
// app/page.tsx (client component)
const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
```

### ✅ DO This Instead:

```typescript
// GOOD: Server-side only, no prefix
// lib/supabase.ts
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// GOOD: Used only in API routes
// app/api/participate/route.ts
import { supabaseAdmin } from '@/lib/supabase';

// GOOD: Never logged or exposed
export async function POST(request: NextRequest) {
  // Use supabaseAdmin, don't reference env var directly
  const { data, error } = await supabaseAdmin.from('table').select();
}
```

## 🔐 Additional Security Measures

### 1. Error Handling

Ensure errors don't leak sensitive information:

```typescript
try {
  // API logic
} catch (error) {
  // DON'T return full error details in production
  return NextResponse.json(
    { 
      error: 'Internal server error',
      // Don't include: error.stack, error.message with sensitive info
      message: 'An unexpected error occurred'
    },
    { status: 500 }
  );
}
```

### 2. Rate Limiting

Consider adding rate limiting to prevent brute force attacks:

```typescript
// middleware.ts or API routes
// Implement rate limiting per IP or user
```

### 3. HTTPS Only

- ✅ Always use HTTPS in production
- ✅ Service role key transmitted over encrypted connection (server-internal only)

### 4. Environment-Specific Keys

Use different service role keys for development/staging/production:

```bash
# .env.local (development)
SUPABASE_SERVICE_ROLE_KEY=dev_key_here

# .env.production (production)
SUPABASE_SERVICE_ROLE_KEY=prod_key_here
```

## 🧪 Security Testing

### Test 1: Network Inspection

1. Start your Next.js server: `npm run dev`
2. Open Burp Suite and configure proxy
3. Make requests from Flutter app through Burp Suite
4. **Expected Result**: Only see JWT tokens, no service role key

### Test 2: Source Code Check

```bash
# Verify service role key not in client bundles
npm run build
grep -r "SUPABASE_SERVICE_ROLE_KEY" .next/ 2>/dev/null
# Should return empty or only hash references (no actual key value)
```

### Test 3: Error Response Check

```bash
# Trigger an error and check response
curl -X POST http://localhost:3000/api/participate \
  -H "Content-Type: application/json" \
  -d '{"invalid": "data"}'

# Verify response does NOT contain:
# - Service role key
# - Environment variable names/values
# - Database connection strings
# - Stack traces with file paths
```

## 📋 Production Deployment Checklist

Before deploying to production:

- [ ] All `.env*` files in `.gitignore`
- [ ] No `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY` exists
- [ ] Service role key only used in `/lib/supabase.ts` and API routes
- [ ] No `console.log` of environment variables
- [ ] Error responses sanitized (no sensitive data)
- [ ] HTTPS enabled
- [ ] Rate limiting implemented (optional but recommended)
- [ ] Different keys for dev/staging/prod environments

## 🎯 Summary

**Your service role key is secure because:**

1. ✅ Stored server-side only (`.env.local`)
2. ✅ Never sent to client/browser
3. ✅ Only used in API routes (server-side)
4. ✅ Not in Git repository
5. ✅ Not visible in network traffic (Burp Suite, etc.)

**What attackers see with Burp Suite:**
- Just the user's JWT token
- Public API requests/responses
- No access to server-side secrets

**Your service role key is safe! 🎉**
