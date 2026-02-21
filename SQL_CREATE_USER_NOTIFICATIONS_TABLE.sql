-- =====================================================
-- USER NOTIFICATIONS TABLE
-- =====================================================
-- This table stores notification history for users
-- Each user can only see their own notifications via RLS
-- =====================================================

-- Create the user_notifications table
CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- e.g., 'new_follower', 'tournament_reminder', etc.
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  data JSONB DEFAULT '{}', -- Additional data related to the notification
  is_read BOOLEAN DEFAULT FALSE,
  sent BOOLEAN NOT NULL DEFAULT FALSE, -- Tracks if push notification was successfully sent
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_user_notifications_user_id ON user_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_user_notifications_created_at ON user_notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_is_read ON user_notifications(is_read);
CREATE INDEX IF NOT EXISTS idx_user_notifications_type ON user_notifications(type);

-- Enable Row Level Security
ALTER TABLE user_notifications ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for re-running this script)
DROP POLICY IF EXISTS "Users can view their own notifications" ON user_notifications;

-- RLS Policy: Users can only SELECT (READ) their own notifications
-- Users CANNOT update or delete notifications - backend handles all write operations
CREATE POLICY "Users can view their own notifications"
  ON user_notifications
  FOR SELECT
  USING (auth.uid() = user_id);

-- Backend with service role key can INSERT/UPDATE/DELETE notifications for any user
-- Service role key bypasses RLS policies

-- Create a function to auto-update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_notifications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update updated_at on UPDATE
DROP TRIGGER IF EXISTS trigger_update_user_notifications_updated_at ON user_notifications;
CREATE TRIGGER trigger_update_user_notifications_updated_at
  BEFORE UPDATE ON user_notifications
  FOR EACH ROW
  EXECUTE FUNCTION update_user_notifications_updated_at();

-- =====================================================
-- USAGE EXAMPLES
-- =====================================================

-- Insert a notification (done by backend with service role key):
-- INSERT INTO user_notifications (user_id, type, title, message, data)
-- VALUES ('user-uuid', 'new_follower', 'New Follower! 🎉', '@username started following you', '{"follower_id": "uuid", "follower_username": "username"}');

-- Query notifications as a user (via RLS):
-- SELECT * FROM user_notifications WHERE user_id = auth.uid() ORDER BY created_at DESC;

-- Mark notification as read (done by backend with service role key):
-- UPDATE user_notifications SET is_read = TRUE WHERE id = 'notification-uuid' AND user_id = 'user-uuid';

-- Delete notification (done by backend with service role key):
-- DELETE FROM user_notifications WHERE id = 'notification-uuid' AND user_id = 'user-uuid';

-- =====================================================
-- NOTES
-- =====================================================
-- 1. Users can ONLY READ their own notifications (SELECT only)
-- 2. Users CANNOT update or delete notifications directly
-- 3. Backend uses service role key to INSERT/UPDATE/DELETE notifications
-- 4. All write operations are handled by backend endpoints with proper authorization
-- 5. Notifications are automatically timestamped
-- 6. is_read flag allows tracking read/unread status via backend
-- 7. data field stores additional JSON data for each notification type
-- =====================================================
