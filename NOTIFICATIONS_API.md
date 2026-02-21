# User Notifications System

## Overview

The user notifications system stores and manages in-app notifications for users. **Users can only READ their own notifications** - all write operations (create, update, delete) are handled by the backend using the service role key.

## Database Setup

### 1. Run the SQL Script

Execute the SQL script in your Supabase SQL Editor:

```bash
SQL_CREATE_USER_NOTIFICATIONS_TABLE.sql
```

This creates:
- `user_notifications` table with RLS enabled
- Indexes for optimal query performance
- **READ-ONLY RLS policy** - users can only SELECT their notifications
- Backend with service role key handles all write operations
- Automatic timestamp updates

### Table Schema

```sql
user_notifications (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id),
  type VARCHAR(50),              -- e.g., 'new_follower', 'tournament_reminder'
  title VARCHAR(255),
  message TEXT,
  data JSONB,                    -- Additional notification data
  is_read BOOLEAN DEFAULT FALSE,
  sent BOOLEAN DEFAULT FALSE,    -- Tracks if push notification was sent
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
```

## API Endpoints

### Get Notifications (READ-ONLY)

**GET** `/api/notifications`

Fetch user notifications with pagination and filtering. **This is the only endpoint users can access.**

**Headers:**
```
Authorization: Bearer <JWT_TOKEN>
```

**Query Parameters:**
- `limit` (optional, default: 50) - Number of notifications to fetch
- `offset` (optional, default: 0) - Pagination offset
- `unread_only` (optional, default: false) - If true, returns only unread notifications
- `type` (optional) - Filter by notification type (e.g., 'new_follower')

**Example Request:**
```dart
// Flutter/Dart example
final response = await http.get(
  Uri.parse('$baseUrl/api/notifications?limit=20&offset=0&unread_only=true'),
  headers: {
    'Authorization': 'Bearer $jwtToken',
    'Content-Type': 'application/json',
  },
);
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "notifications": [
      {
        "id": "uuid",
        "user_id": "user-uuid",
        "type": "new_follower",
        "title": "New Follower! 🎉",
        "message": "@johndoe started following you",
        "data": {
          "follower_id": "uuid",
          "follower_username": "johndoe",
          "follow_id": "uuid"
        },
        "is_read": false,
        "sent": true,
        "created_at": "2026-02-17T10:30:00Z",
        "updated_at": "2026-02-17T10:30:00Z"
      }
    ],
    "total_count": 45,
    "unread_count": 12,
    "limit": 20,
    "offset": 0
  }
}
```

---

## How Notifications Are Created

Notifications are automatically created when certain events occur:

### 1. New Follower Notification

When user A follows user B:
1. A follow relationship is created in the `followers` table
2. A notification is stored in `user_notifications` for user B with `sent: false`
3. A push notification is sent to user B via OneSignal (if enabled)
4. If push notification succeeds, the `sent` field is updated to `true`

**Notification Data:**
```json
{
  "user_id": "user-b-id",
  "type": "new_follower",
  "title": "New Follower! 🎉",
  "message": "@userA started following you",
  "data": {
    "follower_id": "user-a-id",
    "follower_username": "userA",
    "follow_id": "follow-record-id"
  },
  "is_read": false,
  "sent": true
}
```

### 2. Tournament Registration Notification

When a user successfully registers for a tournament:
1. Tournament participation is created in the `tournament_participants` table
2. A notification is stored in `user_notifications` for the user with `sent: false`
3. A push notification is sent to the user via OneSignal (if enabled)
4. If push notification succeeds, the `sent` field is updated to `true`

**Notification Data:**
```json
{
  "user_id": "user-id",
  "type": "tournament_registration",
  "title": "Registration Successful! 🎮",
  "message": "You are registered for Summer Championship 2026",
  "data": {
    "tournament_id": "tournament-uuid",
    "tournament_name": "Summer Championship 2026",
    "participant_id": "participant-uuid",
    "slot_number": 42
  },
  "is_read": false,
  "sent": true
}
```

## Security (RLS Policies)

The `user_notifications` table uses Row Level Security to ensure:

✅ Users can **SELECT** (read) only their own notifications  
❌ Users **CANNOT** update or delete notifications  
✅ Backend with service role key can **INSERT/UPDATE/DELETE** notifications for any user  

This means:
- Users **cannot** see other users' notifications
- Users **cannot** create, update, or delete notifications
- Users can **only read** their own notifications
- All write operations are handled by backend endpoints with service role authorization
- Operations are automatically filtered by `user_id`

## Flutter Integration Example

```dart
class NotificationService {
  final String baseUrl;
  final String jwtToken;

  NotificationService({required this.baseUrl, required this.jwtToken});

  // Fetch notifications (READ-ONLY)
  Future<Map<String, dynamic>> getNotifications({
    int limit = 20,
    int offset = 0,
    bool unreadOnly = false,
    String? type,
  }) async {
    final queryParams = {
      'limit': limit.toString(),
      'offset': offset.toString(),
      if (unreadOnly) 'unread_only': 'true',
      if (type != null) 'type': type,
    };

    final uri = Uri.parse('$baseUrl/api/notifications').replace(
      queryParameters: queryParams,
    );

    final response = await http.get(
      uri,
      headers: {
        'Authorization': 'Bearer $jwtToken',
        'Content-Type': 'application/json',
      },
    );

    if (response.statusCode == 200) {
      return jsonDecode(response.body);
    } else {
      throw Exception('Failed to load notifications');
    }
  }

  // Get unread count quickly
  Future<int> getUnreadCount() async {
    final result = await getNotifications(limit: 1);
    return result['data']['unread_count'] ?? 0;
  }
}
```

**Note:** Users can only **read** notifications. Marking as read, deleting, or any other modifications are handled by the backend automatically or through admin operations.

## Notification Types

Current notification types:
- `new_follower` - When someone follows you
- `tournament_registration` - When you successfully register for a tournament

Future notification types (expand as needed):
- `tournament_starting` - Tournament about to start
- `tournament_result` - Tournament results available
- `wallet_credited` - Wallet balance updated
- `achievement_unlocked` - New achievement earned

## Error Responses

**401 Unauthorized:**
```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing authentication token"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Database error",
  "message": "Failed to fetch notifications"
}
```

## Best Practices

1. **Pagination**: Always use pagination for large notification lists
2. **Unread Badge**: Use `unread_count` from GET response to show badge count in your UI
3. **Polling**: Poll the endpoint periodically to fetch new notifications (every 30-60 seconds)
4. **Real-time**: Consider using Supabase Realtime subscriptions for instant notification updates
5. **Caching**: Cache notifications locally to reduce API calls
6. **Filter by Type**: Use the `type` query parameter to fetch specific notification types

## Testing

Run these in your Supabase SQL Editor to test the table:

```sql
-- Check if table exists
SELECT * FROM user_notifications LIMIT 1;

-- Check RLS policies
SELECT * FROM pg_policies WHERE tablename = 'user_notifications';

-- View notifications as authenticated user (replace with actual user_id)
SELECT * FROM user_notifications WHERE user_id = 'your-user-id';
```

---

**Need more features?** You can extend this system by:
- Adding backend endpoints to mark notifications as read (with proper authorization)
- Adding backend endpoints for notification cleanup/deletion
- Implementing notification categories/channels
- Adding notification preferences per type
- Implementing notification grouping/threading
- Using Supabase Realtime for instant push notifications to the app
