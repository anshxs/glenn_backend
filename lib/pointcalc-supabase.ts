import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const pointcalcSupabaseUrl = process.env.POINTCALC_SUPABASE_URL!;
const pointcalcSupabaseAnonKey = process.env.POINTCALC_SUPABASE_ANON_KEY!;

if (!pointcalcSupabaseUrl || !pointcalcSupabaseAnonKey) {
  throw new Error("Missing PointCalc Supabase environment variables");
}

export type PointCalcUserDataRow = {
  id: string;
  email: string;
  name: string | null;
  aadhar_card: string | null;
  phone: string | null;
  has_access: boolean;
};

export function createPointCalcAnonClient(): SupabaseClient {
  return createClient(pointcalcSupabaseUrl, pointcalcSupabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function createPointCalcUserClient(accessToken: string): SupabaseClient {
  return createClient(pointcalcSupabaseUrl, pointcalcSupabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

export function getPointCalcWhatsappUrl(): string {
  return process.env.POINTCALC_ADMIN_WHATSAPP_URL || "https://wa.me/";
}

export async function getPointCalcUserData(
  accessToken: string,
  userId: string,
) {
  const client = createPointCalcUserClient(accessToken);
  const { data, error } = await client
    .from("userdata")
    .select("id, email, name, aadhar_card, phone, has_access")
    .eq("id", userId)
    .maybeSingle<PointCalcUserDataRow>();

  if (error) {
    throw new Error(error.message || "Unable to load PointCalc user data.");
  }

  return data;
}
