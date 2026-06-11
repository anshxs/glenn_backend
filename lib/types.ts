export interface ParticipateRequest {
  amount: number;
  user_id: string;
  tournament_id: string;
  participant_id: string;
  team_members: Record<string, any>;
  team_name: string | null;
}

export interface Tournament {
  id: string;
  tournament_name: string;
  type: 'solo' | 'duo' | 'squad';
  totalslots: number;
  slotsleft: number;
  entryfee: number;
  tournament_datetime: string;
  registration_allowed: boolean;
  is_external: boolean;
  external_link?: string | null;
  organiser_id?: string;
  organiser_name?: string;
  organiser_contact?: string;
  organiser_commission: number;
}

export interface Wallet {
  id: string;
  user_id: string;
  balance: number;
  allow_withdrawals: boolean;
  allow_deposits: boolean;
}

export interface SensitiveUserData {
  id: string;
  username: string;
  email: string;
  tournmentsplayed: number;
}
