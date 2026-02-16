# Glenn Backend - Setup Instructions

## 🚀 Quick Start

You now have a backend-only Next.js API server with tournament participation functionality!

## ✅ What's Been Set Up

1. **API Endpoints**:
   - `POST /api/participate` - Tournament registration with wallet deduction
   - `GET /api/health` - Health check endpoint

2. **Dependencies Installed**:
   - `@supabase/supabase-js` - Supabase client
   - `jsonwebtoken` - JWT verification
   - All required TypeScript types

3. **Project Structure**:
   ```
   glenn_backend/
   ├── app/
   │   ├── api/
   │   │   ├── participate/route.ts    # Main tournament participation endpoint
   │   │   └── health/route.ts         # Health check endpoint
   │   ├── page.tsx                     # Simple landing page
   │   └── layout.tsx
   ├── lib/
   │   ├── supabase.ts                  # Supabase admin & anon clients
   │   └── types.ts                     # TypeScript interfaces
   ├── .env.local                       # Environment variables (UPDATE THIS!)
   ├── .env.example                     # Environment template
   ├── README.md                        # Full documentation
   └── TESTING.md                       # Testing guide
   ```

## ⚙️ IMPORTANT: Configure Your Environment

**You MUST update `.env.local` with your actual Supabase credentials before running the server!**

1. Open [.env.local](.env.local)
2. Replace the placeholder values:
   ```env
   NEXT_PUBLIC_SUPABASE_URL=https://your-actual-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your_actual_anon_key
   SUPABASE_SERVICE_ROLE_KEY=your_actual_service_role_key
   JWT_SECRET=your_actual_jwt_secret
   ```

3. Get your credentials from:
   - Supabase Dashboard → Project Settings → API
   - **Service Role Key**: Settings → API → service_role (⚠️ Keep secret!)

## 🏃 Running the Server

```bash
# Development mode
npm run dev

# Production build (requires valid env vars)
npm run build
npm start
```

Server runs at: **http://localhost:3000**

## 🧪 Testing

See [TESTING.md](TESTING.md) for detailed testing instructions and examples.

Quick test:
```bash
# Health check
curl http://localhost:3000/api/health

# Participate endpoint (requires valid token)
curl -X POST http://localhost:3000/api/participate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "amount": 100,
    "user_id": "user-uuid",
    "tournament_id": "tournament-uuid",
    "participant_id": "user-uuid",
    "team_members": {},
    "team_name": null
  }'
```

## 📋 How It Works

### POST /api/participate

1. **Verifies JWT token** from Authorization header
2. **Validates user** matches authenticated user
3. **Checks tournament** exists and hasn't started
4. **Validates slots** based on team type (solo/duo/squad)
5. **Checks wallet balance** is sufficient
6. **Deducts fee** from wallet
7. **Creates transaction** (type: TOURNAMENT_FEE_PAY)
8. **Registers participant** in tournament
9. **Updates slots** remaining
10. **Increments** `tournmentsplayed` counter

### Slot Calculation Logic

- **Solo**: 1 slot per participant
- **Duo**: Slots ÷ 2 (rounded up)
- **Squad**: Slots ÷ 4 (rounded up)

This ensures teams with fewer members still count as one team slot.

## 🔒 Security Features

✅ JWT token verification using Supabase Auth  
✅ Service role key for admin operations (bypasses RLS)  
✅ User ID validation prevents impersonation  
✅ Transaction rollback on failures  
✅ Balance verification before deduction  

## 📚 Documentation

- [README.md](README.md) - Complete API documentation
- [TESTING.md](TESTING.md) - Testing guide with examples
- `.env.example` - Environment variable template

## 🎯 Next Steps

1. ✅ Update `.env.local` with real Supabase credentials
2. ✅ Run `npm run dev`
3. ✅ Test with `/api/health` endpoint
4. ✅ Create test tournament data in Supabase
5. ✅ Test `/api/participate` with valid token

## 💡 Flutter Integration

Use this endpoint from your Flutter app:

```dart
final response = await http.post(
  Uri.parse('http://localhost:3000/api/participate'),
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  },
  body: jsonEncode({
    "amount": tournamentEntryFee,
    "user_id": currentUserId,
    "tournament_id": tournamentId,
    "participant_id": currentUserId,
    "team_members": teamMembersMap,
    "team_name": customTeamName,
  }),
);
```

## 🐛 Troubleshooting

**Build fails with "Invalid supabaseUrl"**:
- Update `.env.local` with valid Supabase URL

**"Unauthorized" errors**:
- Check JWT token is valid and not expired
- Verify token is from the same Supabase project

**"Insufficient balance" errors**:
- Check user's wallet in Supabase database
- Ensure `balance` field has enough funds

**"Insufficient slots" errors**:
- Check `slotsleft` in tournaments table
- Verify slot calculation for team type

---

**Need help?** Check the full documentation in [README.md](README.md)
