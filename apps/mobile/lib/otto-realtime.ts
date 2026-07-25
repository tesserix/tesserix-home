// Optional realtime accelerator for the otto inbox + threads. Polling
// (see otto-hooks.ts) is the guaranteed baseline; this hook only *speeds up*
// updates: it mints a short-TTL ticket via the authenticated proxy, opens the
// platform WebSocket DIRECTLY to otto (Istio routes /api/v1/platform/otto/*/ws
// past the Next.js proxy), and calls onFrame() on every inbound frame so the
// screen can invalidate its queries. If the ticket mint or the socket fails,
// nothing breaks — polling still covers the screen. No message parsing, no
// outbox: those live in the mark8ly kit and are a follow-up if needed.

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { plat } from './api';
import type { OttoWsTicketResponse } from './otto-contracts';

const BASE = process.env.EXPO_PUBLIC_API_BASE ?? 'https://tesserix.app';
const WS_BASE = BASE.replace(/^http/i, 'ws').replace(/\/+$/, '');
const MAX_BACKOFF_MS = 15_000;

export interface OttoSocketOpts {
  enabled: boolean;
  onFrame: () => void;
}

// useOttoSocket is the shared engine: mint a ticket at `mintPath` (a `plat`
// path, e.g. '/otto/ws-ticket'), connect to `wsPath` (an otto path under
// /api/v1/platform/otto) with the ticket appended, reconnect with backoff,
// and reconnect when the app returns to the foreground.
function useOttoSocket(mintPath: string, wsPath: string, { enabled, onFrame }: OttoSocketOpts) {
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let stopped = false;
    // Guards the window between kicking off connect() and the ticket mint
    // resolving (ws is still null there) so a foreground event or a queued
    // retry can't slip past the `!ws` check and open a second socket.
    let connecting = false;

    const clearTimer = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      attempts += 1;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempts - 1));
      clearTimer();
      reconnectTimer = setTimeout(() => {
        if (!connecting && !ws) void connect();
      }, delay);
    };

    async function connect() {
      if (stopped) return;
      connecting = true;
      let ticket: string;
      try {
        const res = await plat.post<OttoWsTicketResponse>(mintPath);
        ticket = res.ticket;
      } catch {
        connecting = false;
        scheduleReconnect();
        return;
      }
      if (stopped || !ticket) {
        connecting = false;
        return;
      }
      try {
        ws = new WebSocket(`${WS_BASE}${wsPath}?ticket=${encodeURIComponent(ticket)}`);
      } catch {
        connecting = false;
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        connecting = false;
        attempts = 0;
      };
      ws.onmessage = () => onFrameRef.current();
      ws.onerror = () => {};
      ws.onclose = () => {
        ws = null;
        connecting = false;
        if (!stopped) scheduleReconnect();
      };
    }

    const onAppState = (s: AppStateStatus) => {
      if (s === 'active' && !ws && !connecting) {
        clearTimer();
        attempts = 0;
        void connect();
      }
    };
    const sub = AppState.addEventListener('change', onAppState);

    void connect();

    return () => {
      stopped = true;
      clearTimer();
      sub.remove();
      connecting = false;
      if (ws) {
        ws.close();
        ws = null;
      }
    };
  }, [enabled, mintPath, wsPath]);
}

export function useOttoInboxSocket(opts: OttoSocketOpts) {
  useOttoSocket('/otto/ws-ticket', '/api/v1/platform/otto/ws', opts);
}

export function useOttoThreadSocket(id: string, opts: OttoSocketOpts) {
  useOttoSocket(
    `/otto/conversations/${id}/ws-ticket`,
    `/api/v1/platform/otto/conversations/${id}/ws`,
    opts,
  );
}
