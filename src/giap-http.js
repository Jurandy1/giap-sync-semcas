/**
 * Consultas HTTP diretas ao ORDS SIARH (requer cookies de sessão APEX).
 * Endpoint documentado:
 *   GET /ords/saoluis/siarh/pagamentos/remuneracoes
 */
import { normalizarRespostaLista } from './utils.js';

export const GIAP_ORDS_REMUNERACOES =
  'https://saoluis.giap.com.br/ords/saoluis/siarh/pagamentos/remuneracoes';

export function buildRemuneracoesUrl({
  competencia,
  codigoInstituicao = 1,
  codigoOrgao = '',
  nomeServidor = '',
  quantidade = 100
} = {}) {
  const p = new URLSearchParams();
  p.set('competencia', String(competencia));
  p.set('codigo_instituicao', String(codigoInstituicao));
  const nome = String(nomeServidor || '').trim().toUpperCase();
  const org = codigoOrgao != null && codigoOrgao !== '' ? String(codigoOrgao).trim() : '';
  if (org && nome) p.set('codigo_orgao', org);
  if (nome) p.set('nome_servidor', nome);
  p.set('quantidade', String(quantidade || 100));
  return `${GIAP_ORDS_REMUNERACOES}?${p.toString()}`;
}

/** Converte cookies Puppeteer → header Cookie. */
export function cookiesParaHeader(cookies = []) {
  return cookies
    .filter((c) => c.name && c.value != null)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function montarRespostaHttp({ ok, status, url, tempo_ms, texto, via }) {
  const bytes = Buffer.byteLength(texto || '', 'utf8');

  if (!ok) {
    return {
      ok: false,
      status,
      url,
      tempo_ms,
      bytes,
      count: 0,
      erro: `HTTP ${status}: ${String(texto || '').slice(0, 200)}`,
      via
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(texto);
  } catch (e) {
    return {
      ok: false,
      status,
      url,
      tempo_ms,
      bytes,
      count: 0,
      erro: `json_parse: ${e.message}`,
      raw_prefix: String(texto || '').slice(0, 200),
      via
    };
  }

  const { lista, meta, erro } = normalizarRespostaLista(parsed, { requestUrl: url });
  if (erro) {
    return {
      ok: false,
      status,
      url,
      tempo_ms,
      bytes,
      count: 0,
      erro,
      meta,
      via
    };
  }

  const primeiro = lista[0]
    ? {
        matricula: lista[0].matricula,
        funcionario: lista[0].funcionario,
        codigo_orgao: lista[0].codigo_orgao,
        lotacao: lista[0].lotacao
      }
    : null;

  return {
    ok: true,
    status,
    url,
    tempo_ms,
    bytes,
    count: lista.length,
    primeiro,
    data: lista,
    responseMeta: meta,
    via
  };
}

/**
 * GET /remuneracoes com cookies de sessão (Node fetch).
 * @returns {{ ok, status, url, tempo_ms, bytes, count, primeiro, data, erro, via }}
 */
export async function fetchRemuneracoesHttp(opts = {}) {
  const t0 = Date.now();
  const url = opts.url || buildRemuneracoesUrl(opts);
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'giap-sync-semcas/1.1'
  };
  const cookieHdr = opts.cookieHeader || cookiesParaHeader(opts.cookies);
  if (cookieHdr) headers.Cookie = cookieHdr;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(Number(opts.timeoutMs || 30000))
    });
    const texto = await res.text();
    return montarRespostaHttp({
      ok: res.ok,
      status: res.status,
      url,
      tempo_ms: Date.now() - t0,
      texto,
      via: 'http_node'
    });
  } catch (e) {
    return {
      ok: false,
      url,
      tempo_ms: Date.now() - t0,
      bytes: 0,
      count: 0,
      erro: e.message,
      via: 'http_node'
    };
  }
}

/**
 * GET /remuneracoes via fetch() no contexto do browser (cookies HttpOnly da sessão APEX).
 */
export async function fetchRemuneracoesViaPage(page, opts = {}) {
  const t0 = Date.now();
  const url = opts.url || buildRemuneracoesUrl(opts);
  if (!page) {
    return {
      ok: false,
      url,
      tempo_ms: 0,
      bytes: 0,
      count: 0,
      erro: 'pagina_indisponivel',
      via: 'http_browser'
    };
  }

  try {
    const raw = await page.evaluate(async (fetchUrl) => {
      const res = await fetch(fetchUrl, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' }
      });
      const text = await res.text();
      return { status: res.status, ok: res.ok, text };
    }, url);

    return montarRespostaHttp({
      ok: raw.ok,
      status: raw.status,
      url,
      tempo_ms: Date.now() - t0,
      texto: raw.text,
      via: 'http_browser'
    });
  } catch (e) {
    return {
      ok: false,
      url,
      tempo_ms: Date.now() - t0,
      bytes: 0,
      count: 0,
      erro: e.message,
      via: 'http_browser'
    };
  }
}
