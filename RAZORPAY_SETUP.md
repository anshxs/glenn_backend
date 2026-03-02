# Razorpay Payment Integration - Setup Instructions

## Backend Setup (glenn_backend)

### 1. Install Required Dependencies

```bash
cd glenn_backend
npm install razorpay
```

### 2. Environment Variables

Add these to your `.env` or `.env.local` file:

```env
# Razorpay Credentials
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxxxxxxxxxxxxxxxxxx

# Supabase (if not already added)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### 3. Get Razorpay Credentials

1. Sign up at https://razorpay.com/
2. Go to Dashboard → Settings → API Keys
3. Generate Test Mode keys (for development)
4. Generate Live Mode keys (for production)
5. For webhook secret: Dashboard → Settings → Webhooks → Create Webhook
   - URL: `https://your-backend-url.vercel.app/api/webhooks/razorpay`
   - Events to subscribe: `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`
   - Copy the webhook secret

### 4. Run Database Migrations

Execute these SQL files in order in your Supabase SQL editor:

```sql
-- 1. Add Razorpay columns to transactions table
-- File: supabase_migrations/020_add_razorpay_columns_to_transactions.sql

-- 2. Add RLS policies
-- File: supabase_migrations/021_transactions_rls_policies.sql

-- 3. Add auto-cancel function for stale transactions
-- File: supabase_migrations/022_auto_cancel_stale_transactions.sql
```

### 5. Set Up Cron Job for Stale Transactions (Optional)

Create a cron job in Supabase or use Vercel Cron Jobs to run this every 5 minutes:

```sql
SELECT cancel_stale_pending_transactions();
```

Or create a Next.js API route with Vercel Cron:

**File: `api/cron/cleanup-transactions/route.ts`**
```typescript
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'edge';

export async function GET(req: Request) {
  // Verify cron secret
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error } = await supabase.rpc('cancel_stale_pending_transactions');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
```

**File: `vercel.json`**
```json
{
  "crons": [
    {
      "path": "/api/cron/cleanup-transactions",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

## Frontend Setup (glenn Flutter app)

### 1. Add Razorpay Dependency

Add to `pubspec.yaml`:

```yaml
dependencies:
  razorpay_flutter: ^1.3.6
  http: ^1.1.0
```

Then run:
```bash
cd glenn
flutter pub get
```

### 2. Android Configuration

**File: `android/app/src/main/AndroidManifest.xml`**

Add inside `<application>` tag:
```xml
<activity
    android:name="com.razorpay.CheckoutActivity"
    android:configChanges="keyboard|keyboardHidden|orientation|screenSize"
    android:exported="true"
    android:theme="@style/CheckoutTheme">
</activity>
```

### 3. iOS Configuration

**File: `ios/Podfile`**

Ensure minimum iOS version is 11.0:
```ruby
platform :ios, '11.0'
```

### 4. Update Backend URL

In the Flutter service file (`lib/services/razorpay_payment_service.dart`), update:

```dart
final String baseUrl = 'https://your-backend-url.vercel.app';
```

## Testing

### Test Mode
1. Use test API keys from Razorpay dashboard
2. Test cards: https://razorpay.com/docs/payments/payments/test-card-details/
   - Success: 4111 1111 1111 1111
   - Failure: 4111 1111 1111 1112

### Test Flow
1. **Create Order**: 
   ```bash
   curl -X POST https://your-backend/api/payments/create-order \
     -H "Content-Type: application/json" \
     -d '{"user_id": "user-uuid", "amount": 100}'
   ```

2. **Verify Payment** (after successful Razorpay payment):
   ```bash
   curl -X POST https://your-backend/api/payments/verify \
     -H "Content-Type: application/json" \
     -d '{
       "transaction_id": "transaction-uuid",
       "razorpay_payment_id": "pay_xxxx",
       "razorpay_order_id": "order_xxxx",
       "razorpay_signature": "signature"
     }'
   ```

## Monitoring

### Check Pending Transactions
```sql
SELECT * FROM transactions 
WHERE payment_status = 'pending' 
AND transaction_type = 'RAZORPAY_MONEY_ADD'
ORDER BY created_at DESC;
```

### Get Statistics
```sql
SELECT * FROM get_pending_transactions_stats();
```

### Monitor Failed Payments
```sql
SELECT user_id, amount, payment_metadata 
FROM transactions 
WHERE payment_status = 'failed' 
AND created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

## Production Checklist

- [ ] Switch to Live Mode API keys
- [ ] Update webhook URL to production backend
- [ ] Enable RLS on transactions table
- [ ] Set up monitoring for failed payments
- [ ] Set up cron job for stale transaction cleanup
- [ ] Test payment flow end-to-end
- [ ] Add proper error logging (e.g., Sentry)
- [ ] Add user notifications for payment success/failure
- [ ] Set up alerts for critical errors
- [ ] Document refund process (if applicable)
- [ ] Add rate limiting to prevent abuse
- [ ] Implement proper audit logging

## Troubleshooting

### Common Issues

1. **Signature Verification Failed**
   - Check if RAZORPAY_KEY_SECRET is correct
   - Ensure the order_id and payment_id are being passed correctly

2. **Wallet Not Updated**
   - Check database logs for wallet update errors
   - Verify the user's wallet exists and allow_deposits is true
   - Check for optimistic locking failures

3. **Webhook Not Receiving Events**
   - Verify webhook URL is correct and accessible
   - Check webhook signature verification
   - Test webhook using Razorpay dashboard

4. **Flutter Integration Issues**
   - Ensure razorpay_flutter package is properly installed
   - Check Android/iOS configurations
   - Verify backend URL is correct

## Support

- Razorpay Docs: https://razorpay.com/docs/
- Razorpay Support: https://razorpay.com/support/
- Flutter Plugin: https://pub.dev/packages/razorpay_flutter

## Security Notes

⚠️ **IMPORTANT**:
- Never expose `RAZORPAY_KEY_SECRET` to frontend
- Always verify payments on backend
- Use RLS policies to protect transactions table
- Log all payment operations for audit trail
- Monitor for suspicious activity
- Implement rate limiting on payment endpoints
