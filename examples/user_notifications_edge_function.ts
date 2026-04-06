import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

serve(async (req) => {
  const body = await req.json();
  const notificationId = body.notification_id;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const ONESIGNAL_APP_ID = Deno.env.get("ONESIGNAL_APP_ID")!;
  const ONESIGNAL_REST_KEY = Deno.env.get("ONESIGNAL_REST_KEY")!;

  const { data } = await supabase
    .from("user_notifications")
    .select("*")
    .eq("id", notificationId)
    .eq("sent", false)
    .single();

  if (!data) {
    return new Response("already sent");
  }

  const notifData = asObject(data.data);

  const { data: push } = await supabase
    .from("notifications")
    .select("onesignal_player_id,is_notifications_enabled")
    .eq("user_id", data.user_id)
    .single();

  if (!push?.onesignal_player_id || push.is_notifications_enabled === false) {
    await supabase
      .from("user_notifications")
      .update({ sent: true })
      .eq("id", data.id);
    return new Response("disabled");
  }

  const payload: Record<string, unknown> = {
    app_id: ONESIGNAL_APP_ID,
    include_player_ids: [push.onesignal_player_id],
    headings: { en: data.title },
    contents: { en: data.message },
    data: {
      notification_id: data.id,
      type: data.type,
      ...notifData,
    },
  };

  const largeIcon = notifData.large_icon;
  if (typeof largeIcon === "string" && largeIcon.trim()) {
    payload.large_icon = largeIcon.trim();
  }

  await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${ONESIGNAL_REST_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  await supabase
    .from("user_notifications")
    .update({ sent: true })
    .eq("id", data.id);

  return new Response("done");
});
