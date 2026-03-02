# API Testing Guide

## Testing the /api/participate Endpoint

### Prerequisites

1. Make sure your `.env.local` file is configured with valid Supabase credentials
2. You need a valid user access token from Supabase Auth
3. Ensure you have test data in your Supabase database

### Getting an Access Token

You can get a user access token by:

1. Using Supabase Auth in your Flutter app
2. Using Supabase CLI: `supabase auth login`
3. Or create a test token via Supabase Dashboard

### Example cURL Request

```bash
curl -X POST http://localhost:3000/api/participate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN_HERE" \
  -d '{
    "amount": 100,
    "user_id": "your-user-uuid",
    "tournament_id": "tournament-uuid",
    "participant_id": "your-user-uuid",
    "team_members": {
      "member1": {
        "name": "Player 2",
        "ffuid": "123456"
      }
    },
    "team_name": "My Squad"
  }'
```

### Example with Postman

1. **Method**: POST
2. **URL**: `http://localhost:3000/api/participate`
3. **Headers**:
   - `Content-Type`: `application/json`
   - `Authorization`: `Bearer YOUR_ACCESS_TOKEN`
4. **Body** (raw JSON):
```json
{
  "amount": 100,
  "user_id": "your-user-uuid",
  "tournament_id": "tournament-uuid",
  "participant_id": "your-user-uuid",
  "team_members": {},
  "team_name": null
}
```

### Test Cases

#### 1. Solo Tournament Registration
```json
{
  "amount": 50,
  "user_id": "user-uuid",
  "tournament_id": "solo-tournament-uuid",
  "participant_id": "user-uuid",
  "team_members": {},
  "team_name": null
}
```

#### 2. Duo Tournament Registration
```json
{
  "amount": 100,
  "user_id": "user-uuid",
  "tournament_id": "duo-tournament-uuid",
  "participant_id": "user-uuid",
  "team_members": {
    "uuid-of-member": {
      "name": "Teammate",
      "ffuid": "123456"
    }
  },
  "team_name": "Dynamic Duo"
}
```

#### 3. Squad Tournament Registration
```json
{
  "amount": 200,
  "user_id": "user-uuid",
  "tournament_id": "squad-tournament-uuid",
  "participant_id": "user-uuid",
  "team_members": {
    "member1": {
      "name": "Player 2",
      "ffuid": "123456"
    },
    "member2": {
      "name": "Player 3",
      "ffuid": "234567"
    },
    "member3": {
      "name": "Player 4",
      "ffuid": "345678"
    }
  },
  "team_name": "Elite Squad"
}
```

### Expected Responses

#### Success (200)
```json
{
  "success": true,
  "message": "Successfully registered for tournament",
  "data": {
    "participant_id": "uuid",
    "tournament_id": "uuid",
    "transaction_id": "uuid",
    "fee_paid": 100,
    "team_name": "My Squad",
    "slots_remaining": 95,
    "new_wallet_balance": 900
  }
}
```

#### Insufficient Balance (400)
```json
{
  "error": "Insufficient balance",
  "message": "Insufficient funds in wallet. Required: 100, Available: 50"
}
```

#### Unauthorized (401)
```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing authentication token"
}
```

#### Already Registered (400)
```json
{
  "error": "Already registered",
  "message": "You are already registered for this tournament"
}
```

#### No Slots Available (400)
```json
{
  "error": "Insufficient slots",
  "message": "Not enough slots available. Required: 1, Available: 0"
}
```

### Health Check Endpoint

Test if the API is running:

```bash
curl http://localhost:3000/api/health
```

Expected response:
```json
{
  "status": "ok",
  "message": "Glenn Backend API is running",
  "timestamp": "2026-02-16T..."
}
```

### Checking Database After Registration

After successful registration, verify in Supabase:

1. **tournament_participants** table - should have new entry
2. **transactions** table - should have TOURNAMENT_ENTRY transaction
3. **wallets** table - balance should be reduced
4. **sensitive_userdata** table - `tournmentsplayed` should be incremented
5. **tournaments** table - `slotsleft` should be reduced

### Common Issues

1. **Invalid token**: Make sure the access token is fresh and valid
2. **User ID mismatch**: `user_id` and `participant_id` must match the authenticated user
3. **Service role key**: Ensure `SUPABASE_SERVICE_ROLE_KEY` is set correctly in `.env.local`
4. **Database triggers**: Some operations rely on database triggers, ensure they're set up correctly
