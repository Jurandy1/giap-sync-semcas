/**
 * Cliente Supabase único para Node (Render/Docker).
 * Usa o pacote `ws` porque o @supabase/supabase-js exige WebSocket
 * e imagens Node < 22 não trazem WebSocket nativo.
 */
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

let _sb = null;

export function getSupabase() {
  if (_sb) return _sb;

  const url = process.env.SUPABASE_URL;
  // Aceita o nome correto e o alias antigo (caso alguém tenha cadastrado errado no Render)
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    '';

  if (!url) {
    throw new Error('SUPABASE_URL não configurada no ambiente (Render Environment).');
  }
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY não configurada. ' +
        'No Render, cadastre SUPABASE_SERVICE_ROLE_KEY com a service_role do Supabase.'
    );
  }

  _sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });
  return _sb;
}
