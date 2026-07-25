// Wire shapes for the cross-tenant otto platform inbox, served by
// tesserix-home's /api/admin/otto/* proxy (→ otto /api/v1/platform/otto/*).
// Fields mirror otto's Go models (services/otto/internal/conversation/model.go
// + message/model.go); extra fields on the wire are ignored.

export type OttoStatus = 'pending' | 'active' | 'closed';
export type OttoSenderType = 'customer' | 'staff' | 'system' | 'assistant';

export interface OttoCustomer {
  name?: string;
  email?: string;
  user_id?: string;
  session_token?: string;
}

export interface OttoAssignee {
  user_id: string;
  name?: string;
  email?: string;
  assigned_at?: string;
}

export interface OttoIntake {
  reason: string;
  status: string;
  dob?: string;
  submitted_at?: string;
}

export interface OttoConversation {
  id: string;
  case_id: string;
  tenant_id: string;
  store_id?: string;
  status: OttoStatus;
  subject?: string;
  customer: OttoCustomer;
  assignee?: OttoAssignee;
  intake?: OttoIntake;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  closed_at?: string;
  message_count: number;
  unread_count_staff: number;
}

export interface OttoMessage {
  id: string;
  conversation_id: string;
  sender_type: OttoSenderType;
  sender_name?: string;
  body: string;
  created_at: string;
}

export interface OttoConversationsResponse {
  conversations: OttoConversation[];
}
export interface OttoConversationResponse {
  conversation: OttoConversation;
}
export interface OttoMessagesResponse {
  messages: OttoMessage[];
}
export interface OttoMessageResponse {
  message: OttoMessage;
}
export interface OttoWsTicketResponse {
  ticket: string;
}

// id -> friendly product name. Ported from the web PlatformLiveChatInbox
// TENANT_LABELS so mobile badges match web. Unknown tenant ids fall back to
// the raw id in the badge.
export const OTTO_TENANT_LABELS: Record<string, string> = {
  platform: 'Tesserix',
  homechef: 'HomeChef',
  fanzone: 'FanZone',
  mark8ly: 'mark8ly',
  horoscope: 'Horoscope',
  stockpilot: 'StockPilot',
  scrapper: 'Social Scraper',
  gameverse: 'GameVerse',
  'mp-customer': 'Marketplace',
};

export function ottoTenantLabel(id: string): string {
  return OTTO_TENANT_LABELS[id] ?? id;
}
