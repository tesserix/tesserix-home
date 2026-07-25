// TanStack Query hooks over the otto platform inbox, via the `plat` client
// (/api/admin prefix → /api/admin/otto/*). The inbox list and each open
// thread poll while their screen is focused; mutations invalidate the
// affected keys so the queue and thread stay consistent.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { plat } from './api';
import type {
  OttoConversationResponse,
  OttoConversationsResponse,
  OttoMessageResponse,
  OttoMessagesResponse,
  OttoStatus,
} from './otto-contracts';

export interface OttoInboxParams {
  status: OttoStatus;
  tenant?: string;
  assignee?: 'mine';
}

export const ok = {
  inbox: (p: OttoInboxParams) => ['otto', 'inbox', p] as const,
  conversation: (id: string) => ['otto', 'conversation', id] as const,
  messages: (id: string) => ['otto', 'messages', id] as const,
};

export function useOttoInbox(p: OttoInboxParams, refetchInterval: number | false) {
  return useQuery({
    queryKey: ok.inbox(p),
    queryFn: () =>
      plat.get<OttoConversationsResponse>('/otto/conversations', {
        status: p.status,
        tenant: p.tenant || undefined,
        assignee: p.assignee || undefined,
      }),
    refetchInterval,
  });
}

export function useOttoConversation(id: string, refetchInterval: number | false) {
  return useQuery({
    queryKey: ok.conversation(id),
    queryFn: () => plat.get<OttoConversationResponse>(`/otto/conversations/${id}`),
    enabled: !!id,
    refetchInterval,
  });
}

export function useOttoMessages(id: string, refetchInterval: number | false) {
  return useQuery({
    queryKey: ok.messages(id),
    queryFn: () => plat.get<OttoMessagesResponse>(`/otto/conversations/${id}/messages`),
    enabled: !!id,
    refetchInterval,
  });
}

export function useAcceptOtto(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => plat.post<OttoConversationResponse>(`/otto/conversations/${id}/accept`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ok.conversation(id) });
      qc.invalidateQueries({ queryKey: ok.messages(id) });
      qc.invalidateQueries({ queryKey: ['otto', 'inbox'] });
    },
  });
}

export function useSendOttoMessage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      plat.post<OttoMessageResponse>(`/otto/conversations/${id}/messages`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ok.messages(id) });
      qc.invalidateQueries({ queryKey: ok.conversation(id) });
      qc.invalidateQueries({ queryKey: ['otto', 'inbox'] });
    },
  });
}

export function useCloseOtto(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => plat.post<OttoConversationResponse>(`/otto/conversations/${id}/close`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ok.conversation(id) });
      qc.invalidateQueries({ queryKey: ok.messages(id) });
      qc.invalidateQueries({ queryKey: ['otto', 'inbox'] });
    },
  });
}
