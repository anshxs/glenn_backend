# Glenn Backend API

Backend service for tournament participation management using Next.js and Supabase.

## Features

- Tournament participation endpoint
- JWT-based authentication
- Wallet balance management
- Transaction tracking
- Slot management for solo/duo/squad tournaments
- Service role key for secure database operations

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env.local` and fill in your Supabase credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
JWT_SECRET=your_jwt_secret
```

**Important**: Get your service role key from Supabase Dashboard > Settings > API

### 3. Run Development Server

```bash
npm run dev
```

The server will start at `http://localhost:3000`

## API Endpoints

### POST /api/participate

Register a user for a tournament.

**Headers:**
```
Authorization: Bearer <access_token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "amount": 100,
  "user_id": "uuid-of-user",
  "tournament_id": "uuid-of-tournament",
  "participant_id": "uuid-of-user",
  "team_members": {
    "member1": {
      "name": "Player 2",
      "ffuid": "123456"
    }
  },
  "team_name": "My Squad"
}
```

**Response (Success - 200):**
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
    "slot_number": 1,
    "slots_remaining": 95,
    "new_wallet_balance": 900
  }
}
```

**Response (Error - 400/401/403/404/500):**
```json
{
  "error": "Error type",
  "message": "Detailed error message"
}
```

## Validation Rules

### Authentication
- Valid JWT token required in Authorization header
- User ID must match authenticated user

### Wallet
- User must have sufficient balance
- Amount must match tournament entry fee

### Tournament
- Tournament must exist and not have started
- Sufficient slots must be available
- User cannot register twice for same tournament

### Team Size
- **Any team size allowed** - no restrictions on number of players
- Tournament type (solo/duo/squad) determines slot calculation, not team size limits

### Slot Calculation
- Solo: 1 slot per participant
- Duo: Slots divided by 2 (rounded up)
- Squad: Slots divided by 4 (rounded up)

## Database Operations

The endpoint performs the following operations:

1. Verifies JWT token with Supabase Auth
2. Validates user and tournament data
3. Checks wallet balance
4. Deducts tournament fee from wallet
5. Creates transaction record (type: TOURNAMENT_ENTRY)
6. Adds participant to tournament
7. Updates tournament slots
8. Increments `tournmentsplayed` in `sensitive_userdata`

All operations use the Supabase service role key to bypass RLS policies.

## Error Handling

The API includes comprehensive error handling with rollback mechanisms:

- If transaction creation fails → wallet balance is restored
- If participant creation fails → transaction and wallet update are rolled back

## Tech Stack

- Next.js 16.1.6 (App Router)
- Supabase (Database & Auth)
- TypeScript
- JWT Authentication
