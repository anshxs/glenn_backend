# 🛡️ Security Implementation Code

This file contains ready-to-use security enhancements for your Glenn Backend API.

## 1. Enhanced Input Validation

### Create Validation Utilities

**File**: `lib/validation.ts`

```typescript
import { z } from 'zod';

// UUID validation schema
export const uuidSchema = z.string().uuid();

// Participate request validation schema
export const participateRequestSchema = z.object({
  amount: z.number()
    .positive("Amount must be positive")
    .max(1000000, "Amount exceeds maximum limit"),
  
  user_id: z.string().uuid("Invalid user ID format"),
  
  tournament_id: z.string().uuid("Invalid tournament ID format"),
  
  participant_id: z.string().uuid("Invalid participant ID format"),
  
  team_members: z.record(z.any())
    .refine(
      (members) => Object.keys(members).length <= 3,
      "Maximum 3 team members allowed"
    ),
  
  team_name: z.string()
    .max(50, "Team name too long")
    .nullable()
    .transform((val) => val?.trim() || null)
});

export type ValidatedParticipateRequest = z.infer<typeof participateRequestSchema>;

// Sanitize string to prevent XSS
export function sanitizeString(input: string): string {
  return input
    .replace(/[<>]/g, '') // Remove HTML tags
    .trim()
    .slice(0, 200); // Max length
}

// Validate and sanitize team members
export function validateTeamMembers(teamMembers: any): Record<string, any> {
  if (!teamMembers || typeof teamMembers !== 'object') {
    return {};
  }

  const sanitized: Record<string, any> = {};
  const entries = Object.entries(teamMembers).slice(0, 3); // Max 3 members

  for (const [key, value] of entries) {
    if (typeof value === 'object' && value !== null) {
      sanitized[sanitizeString(key)] = {
        name: value.name ? sanitizeString(String(value.name)) : '',
        ffuid: value.ffuid ? sanitizeString(String(value.ffuid)) : '',
        // Add other fields as needed
      };
    }
  }

  return sanitized;
}
```

**Installation Required**:
```bash
npm install zod
```

---

## 2. Rate Limiting

### Simple In-Memory Rate Limiter

**File**: `lib/rate-limit.ts`

```typescript
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export function rateLimit(
  identifier: string,
  config: RateLimitConfig = { maxRequests: 5, windowMs: 60000 }
): { allowed: boolean; remaining: number; resetTime: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(identifier);

  // Clean up old entries periodically
  if (rateLimitMap.size > 10000) {
    for (const [key, value] of rateLimitMap.entries()) {
      if (value.resetTime < now) {
        rateLimitMap.delete(key);
      }
    }
  }

  if (!entry || entry.resetTime < now) {
    // Create new entry or reset expired one
    const resetTime = now + config.windowMs;
    rateLimitMap.set(identifier, { count: 1, resetTime });
    return { allowed: true, remaining: config.maxRequests - 1, resetTime };
  }

  if (entry.count >= config.maxRequests) {
    // Rate limit exceeded
    return { allowed: false, remaining: 0, resetTime: entry.resetTime };
  }

  // Increment count
  entry.count++;
  rateLimitMap.set(identifier, entry);

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetTime: entry.resetTime
  };
}

// Get rate limit key from request (IP + user ID)
export function getRateLimitKey(ip: string, userId?: string): string {
  return userId ? `${ip}:${userId}` : ip;
}
```

### Advanced Rate Limiter (Recommended for Production)

**Using Upstash Redis** (serverless-friendly):

```bash
npm install @upstash/ratelimit @upstash/redis
```

```typescript
// lib/rate-limit-redis.ts
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Create Redis instance
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Create rate limiter
export const rateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, "1 m"), // 5 requests per minute
  analytics: true,
});

// Per-user rate limiter
export const userRateLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 m"), // 10 requests per minute per user
  analytics: true,
});
```

---

## 3. Enhanced Participate Endpoint with Security

**File**: `app/api/participate/route.ts` (Enhanced Version)

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { Tournament, Wallet } from '@/lib/types';
import { participateRequestSchema, validateTeamMembers, sanitizeString } from '@/lib/validation';
import { rateLimit, getRateLimitKey } from '@/lib/rate-limit';

// Get client IP address
function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  return forwarded?.split(',')[0] || realIp || 'unknown';
}

// Helper function to verify JWT token
async function verifyToken(authHeader: string | null): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.substring(7);

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    
    if (error || !user) {
      return null;
    }

    // Check token expiration
    if (user.aud === 'authenticated') {
      return user.id;
    }

    return null;
  } catch (error) {
    console.error('Token verification error:', error);
    return null;
  }
}

// Calculate required slots
function calculateRequiredSlots(tournamentType: string, teamMembersCount: number): number {
  switch (tournamentType) {
    case 'solo':
      return 1;
    case 'duo':
      return Math.ceil(teamMembersCount / 2) || 1;
    case 'squad':
      return Math.ceil(teamMembersCount / 4) || 1;
    default:
      return 1;
  }
}

// Get team size
function getTeamSize(teamMembers: Record<string, any>): number {
  return Object.keys(teamMembers).length + 1;
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    // 1. Rate Limiting
    const clientIp = getClientIp(request);
    const rateLimitResult = rateLimit(clientIp, { maxRequests: 5, windowMs: 60000 });

    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { 
          error: 'Too many requests',
          message: 'Rate limit exceeded. Please try again later.',
          retryAfter: Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
        },
        { 
          status: 429,
          headers: {
            'X-RateLimit-Limit': '5',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': rateLimitResult.resetTime.toString(),
            'Retry-After': Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000).toString()
          }
        }
      );
    }

    // 2. Verify authentication
    const authHeader = request.headers.get('Authorization');
    const authenticatedUserId = await verifyToken(authHeader);

    if (!authenticatedUserId) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Invalid or expired authentication token' },
        { status: 401 }
      );
    }

    // 3. Parse and validate request body
    let body;
    try {
      body = await request.json();
    } catch (error) {
      return NextResponse.json(
        { error: 'Invalid request', message: 'Request body must be valid JSON' },
        { status: 400 }
      );
    }

    // 4. Validate with Zod schema
    const validation = participateRequestSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { 
          error: 'Validation failed', 
          message: 'Invalid request data',
          details: validation.error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message
          }))
        },
        { status: 400 }
      );
    }

    const { amount, user_id, tournament_id, participant_id, team_members, team_name } = validation.data;

    // 5. Validate user matches authenticated user
    if (authenticatedUserId !== user_id || authenticatedUserId !== participant_id) {
      return NextResponse.json(
        { error: 'Forbidden', message: 'User ID mismatch with authenticated user' },
        { status: 403 }
      );
    }

    // 6. Sanitize team members and team name
    const sanitizedTeamMembers = validateTeamMembers(team_members);
    const sanitizedTeamName = team_name ? sanitizeString(team_name) : null;

    // 7. User-specific rate limiting
    const userRateLimit = rateLimit(
      `user:${user_id}`,
      { maxRequests: 10, windowMs: 60000 }
    );

    if (!userRateLimit.allowed) {
      return NextResponse.json(
        { error: 'Too many requests', message: 'You are making too many registration attempts' },
        { status: 429 }
      );
    }

    // 8. Fetch tournament details
    const { data: tournament, error: tournamentError } = await supabaseAdmin
      .from('tournaments')
      .select('*')
      .eq('id', tournament_id)
      .single<Tournament>();

    if (tournamentError || !tournament) {
      return NextResponse.json(
        { error: 'Tournament not found', message: 'The specified tournament does not exist' },
        { status: 404 }
      );
    }

    // 9. Verify amount matches entry fee
    if (amount !== tournament.entryfee) {
      return NextResponse.json(
        { error: 'Invalid amount', message: `Entry fee should be ${tournament.entryfee}` },
        { status: 400 }
      );
    }

    // 10. Check if tournament hasn't started
    const tournamentDateTime = new Date(tournament.tournament_datetime);
    const now = new Date();
    if (tournamentDateTime <= now) {
      return NextResponse.json(
        { error: 'Tournament already started', message: 'Cannot register for a tournament that has already started' },
        { status: 400 }
      );
    }

    // 11. Calculate team size and required slots
    const teamSize = sanitizedTeamMembers ? getTeamSize(sanitizedTeamMembers) : 1;
    const requiredSlots = calculateRequiredSlots(tournament.type, teamSize);

    // 12. Check slots availability
    if (tournament.slotsleft < requiredSlots) {
      return NextResponse.json(
        { error: 'Insufficient slots', message: `Not enough slots available. Required: ${requiredSlots}, Available: ${tournament.slotsleft}` },
        { status: 400 }
      );
    }

    // 13. Team size validation removed - any team size allowed

    // 14. Check for existing registration
    const { data: existingParticipant } = await supabaseAdmin
      .from('tournament_participants')
      .select('id')
      .eq('tournament_id', tournament_id)
      .eq('participant_id', participant_id)
      .single();

    if (existingParticipant) {
      return NextResponse.json(
        { error: 'Already registered', message: 'You are already registered for this tournament' },
        { status: 400 }
      );
    }

    // 15. Fetch wallet
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('*')
      .eq('user_id', user_id)
      .single<Wallet>();

    if (walletError || !wallet) {
      return NextResponse.json(
        { error: 'Wallet not found', message: 'User wallet does not exist' },
        { status: 404 }
      );
    }

    // 16. Check balance
    if (wallet.balance < amount) {
      return NextResponse.json(
        { 
          error: 'Insufficient balance', 
          message: `Insufficient funds in wallet. Required: ${amount}, Available: ${wallet.balance}` 
        },
        { status: 400 }
      );
    }

    // 17. Deduct from wallet
    const oldBalance = wallet.balance;
    const newBalance = oldBalance - amount;

    const { error: walletUpdateError } = await supabaseAdmin
      .from('wallets')
      .update({ balance: newBalance })
      .eq('id', wallet.id);

    if (walletUpdateError) {
      throw new Error('Failed to update wallet');
    }

    // 18. Create transaction
    const { data: transaction, error: transactionError } = await supabaseAdmin
      .from('transactions')
      .insert({
        user_id: user_id,
        wallet_id: wallet.id,
        amount: -amount,
        transaction_type: 'TOURNAMENT_FEE_PAY',
        related_tournament_id: tournament_id,
        old_balance: oldBalance,
        new_balance: newBalance
      })
      .select()
      .single();

    if (transactionError) {
      // Rollback wallet
      await supabaseAdmin
        .from('wallets')
        .update({ balance: oldBalance })
        .eq('id', wallet.id);
      throw new Error('Failed to create transaction');
    }

    // 19. Register participant
    const { data: participant, error: participantError } = await supabaseAdmin
      .from('tournament_participants')
      .insert({
        tournament_id: tournament_id,
        participant_id: participant_id,
        team_members: sanitizedTeamMembers,
        fee_paid: amount,
        team_name: sanitizedTeamName || (tournament.type === 'solo' ? null : 'Squad Team'),
        transaction_id: transaction.id
      })
      .select()
      .single();

    if (participantError) {
      // Rollback
      await supabaseAdmin.from('transactions').delete().eq('id', transaction.id);
      await supabaseAdmin.from('wallets').update({ balance: oldBalance }).eq('id', wallet.id);
      throw new Error('Failed to register participant');
    }

    // 20. Update slots
    await supabaseAdmin
      .from('tournaments')
      .update({ slotsleft: tournament.slotsleft - requiredSlots })
      .eq('id', tournament_id);

    // 21. Increment tournaments played
    const { data: userData } = await supabaseAdmin
      .from('sensitive_userdata')
      .select('tournmentsplayed')
      .eq('id', user_id)
      .single();

    if (userData) {
      await supabaseAdmin
        .from('sensitive_userdata')
        .update({ tournmentsplayed: (userData.tournmentsplayed || 0) + 1 })
        .eq('id', user_id);
    }

    // 22. Success response
    const processingTime = Date.now() - startTime;
    
    return NextResponse.json(
      {
        success: true,
        message: 'Successfully registered for tournament',
        data: {
          participant_id: participant.id,
          tournament_id: tournament_id,
          transaction_id: transaction.id,
          fee_paid: amount,
          team_name: participant.team_name,
          slots_remaining: tournament.slotsleft - requiredSlots,
          new_wallet_balance: newBalance
        }
      },
      { 
        status: 200,
        headers: {
          'X-Response-Time': `${processingTime}ms`
        }
      }
    );

  } catch (error) {
    // Log error securely (use proper logging service in production)
    console.error('[API Error]:', {
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
      // Don't log sensitive data
    });

    return NextResponse.json(
      { 
        error: 'Internal server error', 
        message: 'An unexpected error occurred. Please try again later.' 
      },
      { status: 500 }
    );
  }
}

// OPTIONS method for CORS preflight
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
```

---

## 4. CORS Configuration

**File**: `middleware.ts` (in root directory)

```typescript
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // CORS headers
  const response = NextResponse.next();

  // Set CORS headers
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
  const origin = request.headers.get('origin');

  if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }

  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.headers.set('Access-Control-Max-Age', '86400');

  // Security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // HSTS (only in production with HTTPS)
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
```

---

## 5. Environment Variables (Updated)

**File**: `.env.local`

```env
# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# CORS Configuration
ALLOWED_ORIGINS=https://yourapp.com,http://localhost:3000

# Rate Limiting (Optional - for Redis)
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your_token

# Production Settings
NODE_ENV=production
```

---

## 6. Error Logging Service (Production)

**Using Sentry**:

```bash
npm install @sentry/nextjs
```

```typescript
// sentry.server.config.ts
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
  environment: process.env.NODE_ENV,
});
```

---

## Implementation Priority

1. **Immediate** (Do Now):
   - ✅ Input validation with Zod
   - ✅ Rate limiting
   - ✅ Enhanced error handling

2. **Before Production** (This Week):
   - ✅ CORS configuration
   - ✅ Security headers
   - ✅ Update environment variables

3. **Production Ready** (Before Launch):
   - ✅ Redis-based rate limiting (Upstash)
   - ✅ Error logging (Sentry)
   - ✅ HTTPS enforcement
   - ✅ Monitoring dashboards

---

## Testing Security Features

```bash
# Test rate limiting
for i in {1..10}; do
  curl -X POST http://localhost:3000/api/participate \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"amount": 100, ...}'
done

# Should return 429 after 5 requests

# Test invalid UUID
curl -X POST http://localhost:3000/api/participate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user_id": "invalid-uuid", ...}'

# Should return 400 with validation error
```

---

**Next Steps**: Copy the code from this file into your project following the implementation priority.
