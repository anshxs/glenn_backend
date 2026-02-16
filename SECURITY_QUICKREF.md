# 🔒 Security Quick Reference

## Your Current Security Status

### ✅ GOOD - Already Implemented
- JWT token verification via Supabase Auth
- Service role key for admin operations (server-side only)
- User ID validation (prevents impersonation)
- Transaction rollback on failures
- No JWT_SECRET needed (Supabase handles this!)

### ⚠️ RECOMMENDED - Should Add Soon
- **Rate Limiting** (5 req/min) - Prevents spam/DDoS
- **Input Validation** with Zod - Prevents malformed data
- **CORS Headers** - For Flutter web apps
- **Enhanced Error Handling** - Don't expose internals

### 🚀 PRODUCTION - Before Launch
- HTTPS only (auto on Vercel/hosting)
- Redis-based rate limiting (Upstash)
- Error monitoring (Sentry)
- Row Level Security (RLS) in Supabase

---

## Where to Get Credentials

### 1. Supabase Service Role Key ⚠️ CRITICAL

**Location**: Supabase Dashboard → Settings → API

```
Project Settings
  └── API
      └── Project API keys
          └── service_role (secret) ← Copy this
```

**Add to `.env.local`**:
```env
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Security Rules**:
- ❌ NEVER commit to Git
- ❌ NEVER expose to frontend
- ✅ Only use server-side (API routes)
- ✅ Rotate if compromised
- ✅ Use environment variables in production

### 2. Supabase URL & Anon Key

**Same location** (Settings → API):
```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
```

These can be public (but still use env vars).

### 3. JWT Secret

**YOU DON'T NEED THIS!** ✅

Supabase manages JWT signing/verification internally. Your current implementation using `supabaseAdmin.auth.getUser(token)` is correct and secure.

---

## Security Flow (Your Current Setup)

```
┌─────────────────────────────────────────────────┐
│  Flutter App (Frontend)                         │
│  ├── User logs in with Supabase Auth            │
│  ├── Gets access_token (JWT)                    │
│  └── Stores in FlutterSecureStorage             │
└─────────────────┬───────────────────────────────┘
                  │ HTTPS + Bearer Token
                  ↓
┌─────────────────────────────────────────────────┐
│  Next.js API (/api/participate)                 │
│  ├── ✅ Extracts Bearer token                   │
│  ├── ✅ Verifies with Supabase.auth.getUser()   │
│  ├── ✅ Validates user_id matches token         │
│  ├── ✅ Checks wallet balance                   │
│  ├── ✅ Uses SERVICE_ROLE_KEY for DB ops        │
│  └── ✅ Rollback on errors                      │
└─────────────────┬───────────────────────────────┘
                  │ Service Role Key (admin)
                  ↓
┌─────────────────────────────────────────────────┐
│  Supabase Database                              │
│  ├── Updates wallet (bypasses RLS)              │
│  ├── Creates transaction                        │
│  ├── Registers participant                      │
│  └── Database triggers handle constraints       │
└─────────────────────────────────────────────────┘
```

**Security Score**: **6.5/10** (Current)  
**With Improvements**: **9.5/10** ✨

---

## Top 5 Security Improvements (Priority Order)

### 1️⃣ Add Rate Limiting (10 min)
**Impact**: 🔥 Critical - Prevents DDoS

```typescript
// lib/rate-limit.ts - Simple in-memory version
// See SECURITY_IMPLEMENTATION.md for full code
```

Limits: 5 requests/min per IP

### 2️⃣ Add Input Validation (15 min)
**Impact**: 🔥 Critical - Prevents injection

```bash
npm install zod
```

```typescript
// Validates UUIDs, amounts, team data
// See SECURITY_IMPLEMENTATION.md
```

### 3️⃣ Add CORS Headers (5 min)
**Impact**: ⚠️ Important - For Flutter Web

```typescript
// middleware.ts in root directory
// See SECURITY_IMPLEMENTATION.md
```

### 4️⃣ Enhance Error Handling (10 min)
**Impact**: ⚠️ Important - Don't leak internals

```typescript
// Don't expose database errors to users
// Generic error messages
```

### 5️⃣ Add Monitoring (20 min)
**Impact**: ⚠️ Important - Track issues

```bash
npm install @sentry/nextjs
# Or use LogRocket, Datadog, etc.
```

---

## Flutter App Security Checklist

### ✅ Token Storage
```dart
// Use flutter_secure_storage
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

final storage = FlutterSecureStorage();
await storage.write(key: 'access_token', value: token);
```

### ✅ HTTPS Only
```dart
// Production URL
final apiUrl = 'https://your-api.com/api/participate';
// NOT: http://...
```

### ✅ Token Refresh
```dart
// Supabase tokens expire in ~1 hour
// Implement auto-refresh:
final session = await supabase.auth.refreshSession();
```

### ✅ Error Handling
```dart
try {
  final response = await http.post(...);
  if (response.statusCode == 429) {
    // Rate limited - show retry message
  }
} on SocketException {
  // No internet
} on TimeoutException {
  // Request timeout
}
```

---

## Production Deployment Checklist

Before launching:

- [ ] Update `.env.local` with real Supabase credentials
- [ ] Add rate limiting (at minimum, in-memory)
- [ ] Add input validation with Zod
- [ ] Configure CORS for your Flutter app domain
- [ ] Enable HTTPS (auto on Vercel)
- [ ] Set up error monitoring (Sentry)
- [ ] Add Row Level Security (RLS) policies in Supabase
- [ ] Test with expired tokens
- [ ] Test with invalid data
- [ ] Load test with multiple concurrent requests
- [ ] Review database indexes for performance
- [ ] Set up database backups (auto in Supabase)
- [ ] Document API for your team
- [ ] Set up staging environment
- [ ] Configure environment variables in hosting platform

---

## Quick Test Commands

### 1. Health Check
```bash
curl http://localhost:3000/api/health
```

### 2. Test Participate Endpoint
```bash
curl -X POST http://localhost:3000/api/participate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "amount": 100,
    "user_id": "uuid",
    "tournament_id": "uuid",
    "participant_id": "uuid",
    "team_members": {},
    "team_name": null
  }'
```

### 3. Test Rate Limiting
```bash
# Run 10 times quickly - should rate limit
for i in {1..10}; do curl -X POST http://localhost:3000/api/participate ...; done
```

---

## Common Security Mistakes to Avoid

❌ **Don't do this**:
```typescript
// Exposing service role key
const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
return NextResponse.json({ supabase }); // ❌ Never send keys to client!
```

❌ **Don't do this**:
```typescript
// Skipping validation
const { user_id } = await request.json();
// ❌ What if user_id is not the authenticated user?
```

❌ **Don't do this**:
```typescript
// Exposing internal errors
catch (error) {
  return NextResponse.json({ error }); // ❌ Leaks stack traces!
}
```

✅ **Do this instead**:
```typescript
// Generic error message
catch (error) {
  console.error(error); // Log server-side
  return NextResponse.json({ 
    error: 'Internal server error',
    message: 'Please try again later'
  });
}
```

---

## Resources

📚 **Documentation**:
- [SECURITY_GUIDE.md](SECURITY_GUIDE.md) - Full security analysis
- [SECURITY_IMPLEMENTATION.md](SECURITY_IMPLEMENTATION.md) - Ready-to-use code
- [README.md](README.md) - API documentation
- [TESTING.md](TESTING.md) - Test examples

🔗 **External Resources**:
- [Supabase Auth Docs](https://supabase.com/docs/guides/auth)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Next.js Security](https://nextjs.org/docs/app/building-your-application/security)

---

## Summary

**Your flow is GOOD** ✅ but needs these additions:
1. Rate limiting (critical)
2. Input validation (critical)
3. CORS config (if using Flutter Web)
4. Enhanced error handling

**JWT Secret**: Not needed! Supabase handles it.

**Service Role Key**: Get from Supabase Dashboard → Settings → API → service_role

**Security Level**: Currently 6.5/10, can easily reach 9.5/10 with recommended changes.

See [SECURITY_IMPLEMENTATION.md](SECURITY_IMPLEMENTATION.md) for copy-paste ready code! 🚀
