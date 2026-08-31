/**
 * Sessão APEX reutilizável — cookies para HTTP direto após bootstrap Puppeteer.
 */
import { fetchRemuneracoesHttp } from './giap-http.js';

let cachedCookies = null;
let cachedCookieHeader = null;
let sessionReadyAt = null;

export function getSessionCookies() {
  return cachedCookies;
}

export function getSessionCookieHeader() {
  return cachedCookieHeader;
}

export function isSessionReady() {
  return !!(cachedCookies?.length && cachedCookieHeader);
}

export function atualizarSessao(cookies = []) {
  cachedCookies = cookies;
  cachedCookieHeader = cookies
    .filter((c) => c.name && c.value != null)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  sessionReadyAt = Date.now();
}

export function limparSessao() {
  cachedCookies = null;
  cachedCookieHeader = null;
  sessionReadyAt = null;
}

/** Tenta HTTP direto; retorna null se sessão indisponível ou falhou. */
export async function tentarHttpComSessao(opts = {}) {
  if (process.env.GIAP_HTTP_DIRECT === '0') return null;
  if (!isSessionReady()) return null;

  const t0 = Date.now();
  const res = await fetchRemuneracoesHttp({
    ...opts,
    cookies: cachedCookies
  });

  if (res.ok && res.count >= 0) {
    return {
      ...res,
      tempo_http_ms: res.tempo_ms,
      tempo_total_ms: Date.now() - t0,
      metodo: 'http_sessao',
      session_age_ms: sessionReadyAt ? Date.now() - sessionReadyAt : null
    };
  }

  console.warn(
    JSON.stringify({
      evento: 'giap_http_fallback',
      url: res.url,
      status: res.status,
      erro: res.erro,
      tempo_ms: res.tempo_ms
    })
  );
  return null;
}
