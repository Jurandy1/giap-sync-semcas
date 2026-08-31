/**
 * Sessão APEX reutilizável — cookies para HTTP direto após bootstrap Puppeteer.
 */
import { fetchRemuneracoesHttp, fetchRemuneracoesViaPage } from './giap-http.js';

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

function formatarHitHttp(res, t0) {
  return {
    ...res,
    tempo_http_ms: res.tempo_ms,
    tempo_total_ms: Date.now() - t0,
    metodo: 'http_sessao',
    session_age_ms: sessionReadyAt ? Date.now() - sessionReadyAt : null
  };
}

/** Tenta HTTP direto; retorna null se sessão indisponível ou falhou. */
export async function tentarHttpComSessao(opts = {}, page = null) {
  if (process.env.GIAP_HTTP_DIRECT === '0') return null;
  if (!isSessionReady() && !page) return null;

  const t0 = Date.now();

  if (isSessionReady()) {
    const nodeRes = await fetchRemuneracoesHttp({
      ...opts,
      cookies: cachedCookies
    });
    if (nodeRes.ok && nodeRes.count >= 0) {
      return formatarHitHttp(nodeRes, t0);
    }
    if (!page) {
      console.warn(
        JSON.stringify({
          evento: 'giap_http_fallback',
          via: nodeRes.via,
          url: nodeRes.url,
          status: nodeRes.status,
          erro: nodeRes.erro,
          tempo_ms: nodeRes.tempo_ms
        })
      );
    }
  }

  if (page) {
    const browserRes = await fetchRemuneracoesViaPage(page, opts);
    if (browserRes.ok && browserRes.count >= 0) {
      return formatarHitHttp(browserRes, t0);
    }
    console.warn(
      JSON.stringify({
        evento: 'giap_http_fallback',
        via: browserRes.via,
        url: browserRes.url,
        status: browserRes.status,
        erro: browserRes.erro,
        tempo_ms: browserRes.tempo_ms
      })
    );
  }

  return null;
}
