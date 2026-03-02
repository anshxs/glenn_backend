# Razorpay Payment Integration - Quick Start

## ✅ What's Been Done

I've integrated Razorpay payment gateway into your Glenn app. Here's what's ready:

### Files Modified/Created:
1. **Backend API** (`glenn_backend/api/payments/`)
   - `create-order/route.ts` - Creates Razorpay orders
   - `verify/route.ts` - Verifies payments and updates wallet
   - `webhooks/razorpay/route.ts` - Handles Razorpay webhooks

2. **Flutter App** (`glenn/lib/`)
   - `services/razorpay_payment_service.dart` - Payment service
   - `screens/wallet_screen.dart` - Updated with payment integration

3. **Database Migrations** (`glenn/supabase_migrations/`)
   - `020_add_razorpay_columns_to_transactions.sql`
   - `021_transactions_rls_policies.sql`
   - `022_auto_cancel_stale_transactions.sql`

## 🚀 Setup Steps

### 1. Install Dependencies

#### Backend (glenn_backend):
```bash
cd glenn_backend
npm install razorpay
```

#### Flutter App (glenn):
Dependencies already added by `flutter pub add razorpay_flutter http`

### 2. Configure Environment Variables

#### Backend `.env` (glenn_backend/.env):
```env
# Razorpay Credentials
RAZORPAY_KEY_ID=rzp_test_xxxxx
RAZORPAY_KEY_SECRET=xxxxx
RAZORPAY_WEBHOOK_SECRET=xxxxx

# Existing variables...
```

#### Flutter `.env` (glenn/.env):
```env
# Update this with your actual backend URL
BACKEND_URL=https://your-backend-url.vercel.app
```

### 3. Get Razorpay Credentials

1. Sign up at https://razorpay.com/
2. Go to **Dashboard → Settings → API Keys**
3. Generate **Test Mode** keys for development
4. Copy `Key ID` and `Key Secret`

### 4. Setup Webhook (Backend deployed)

1. Go to **Dashboard → Settings → Webhooks**
2. Click **Create Webhook**
3. URL: `https://your-backend-url.vercel.app/api/webhooks/razorpay`
4. Events: Select `payment.captured`, `payment.failed`, `payment.authorized`, `order.paid`
5. Copy the **Webhook Secret**

### 5. Run Database Migrations

Execute these in Supabase SQL Editor **(in order)**:

```sql
-- 1. Add Razorpay columns
-- Copy content from: supabase_migrations/020_add_razorpay_columns_to_transactions.sql

-- 2. Add RLS policies  
-- Copy content from: supabase_migrations/021_transactions_rls_policies.sql

-- 3. Add auto-cancel function
-- Copy content from: supabase_migrations/022_auto_cancel_stale_transactions.sql
```

### 6. Deploy Backend

Push your backend to Vercel or your hosting platform.

### 7. Update Flutter .env

Update `BACKEND_URL` in `glenn/.env` with your deployed backend URL.

## 🧪 Testing

### Test Mode Cards (Razorpay Docs)
- **Success**: 4111 1111 1111 1111
- **Failure**: 4111 1111 1111 1112
- CVV: Any 3 digits
- Expiry: Any future date

### Testing Flow:
1. Run the Flutter app
2. Navigate to **Wallet Screen**
3. Click **"Add Money"** button
4. Enter amount (100 works well for testing)
5. Click **"Enter"**
6. Razorpay payment dialog opens
7. Use test card details
8. Complete payment
9. Wallet balance updates automatically! 🎉

## 📱 How It Works

1. **User taps "Add Money"** → Dialog opens
2. **Enter amount** → Click "Enter"
3. **Backend creates order** → Razorpay order created, pending transaction saved
4. **Razorpay checkout opens** → User enters payment details
5. **Payment processed** → Razorpay processes payment
6. **Backend verifies** → Payment verified with Razorpay API
7. **Wallet updated** → Balance increased, transaction marked as verified
8. **Success!** → User sees updated balance

## 🔒 Security Features

✅ Payment signature verification
✅ Amount validation (10 min, 50,000 max)
✅ Wallet deposit restrictions checked
✅ Optimistic locking prevents race conditions
✅ Auto-cancellation of stale payments (30 min timeout)
✅ Row Level Security on transactions table
✅ Backend handles all sensitive operations

## 🐛 Troubleshooting

### "Backend URL not configured"
→ Update `BACKEND_URL` in `glenn/.env`

### "Payment verification failed"
→ Check Razorpay credentials in backend `.env`
→ Ensure backend is deployed and accessible

### Wallet not updating
→ Check backend logs
→ Verify Supabase service role key is set
→ Run migrations in order

### Webhook not working
→ Verify webhook URL is correct
→ Check webhook secret matches
→ Test webhook using Razorpay dashboard

## 📊 Monitor Transactions

### Check pending transactions:
```sql
SELECT * FROM transactions 
WHERE payment_status = 'pending' 
AND transaction_type = 'RAZORPAY_MONEY_ADD'
ORDER BY created_at DESC;
```

### Get statistics:
```sql
SELECT * FROM get_pending_transactions_stats();
```

### View recent successful payments:
```sql
SELECT * FROM transactions 
WHERE payment_status = 'verified'
AND transaction_type = 'RAZORPAY_MONEY_ADD'
ORDER BY created_at DESC 
LIMIT 10;
```

## 🎯 Next Steps (Production)

Before going live:

1. [ ] Switch to **Live Mode** Razorpay keys
2. [ ] Update webhook URL to production backend
3. [ ] Test end-to-end with real cards (small amounts)
4. [ ] Set up monitoring/alerts for failed payments
5. [ ] Add error logging (e.g., Sentry)
6. [ ] Implement withdrawal flow (if needed)
7. [ ] Add transaction history screen for users
8. [ ] Set up email notifications for successful payments

## 📚 Documentation

- [RAZORPAY_INTEGRATION.md](RAZORPAY_INTEGRATION.md) - Complete integration guide
- [RAZORPAY_SETUP.md](RAZORPAY_SETUP.md) - Detailed setup instructions
- [Razorpay Docs](https://razorpay.com/docs/)

## 💡 Features

✨ Clean UI with quick amount buttons (100, 500, 1000, 2000, 5000)
✨ Real-time payment verification
✨ Automatic wallet balance updates
✨ Loading states and error handling
✨ Success/failure notifications
✨ Pull-to-refresh wallet data
✨ Deposit/withdrawal restrictions honored

## 🤝 Support

If you face any issues:
1. Check the troubleshooting section above
2. Review backend logs
3. Check Razorpay dashboard for payment status
4. Verify all environment variables are set correctly

---

**Ready to add money to your wallet!** 💰

Just make sure to:
1. Install `razorpay` package in backend
2. Set environment variables
3. Run database migrations
4. Update backend URL in Flutter .env

Then run the app and try adding money! 🚀
