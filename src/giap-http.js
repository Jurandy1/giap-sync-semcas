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

/**
 * GET /remuneracoes com cookies de sessão.
 * @returns {{ ok, status, url, tempo_ms, bytes, count, primeiro, data, erro, via: 'http' }}
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
    const tempo_ms = Date.now() - t0;
    const bytes = Buffer.byteLength(texto, 'utf8');

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        url,
        tempo_ms,
        bytes,
        count: 0,
        erro: `HTTP ${res.status}: ${texto.slice(0, 200)}`,
        via: 'http'
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(texto);
    } catch (e) {
      return {
        ok: false,
        status: res.status,
        url,
        tempo_ms,
        bytes,
        count: 0,
        erro: `json_parse: ${e.message}`,
        raw_prefix: texto.slice(0, 200),
        via: 'http'
      };
    }

    const { lista, meta, erro } = normalizarRespostaLista(parsed, { requestUrl: url });
    if (erro) {
      return {
        ok: false,
        status: res.status,
        url,
        tempo_ms,
        bytes,
        count: 0,
        erro,
        meta,
        via: 'http'
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
      status: res.status,
      url,
      tempo_ms,
      bytes,
      count: lista.length,
      primeiro,
      data: lista,
      responseMeta: meta,
      via: 'http'
    };
  } catch (e) {
    return {
      ok: false,
      url,
      tempo_ms: Date.now() - t0,
      bytes: 0,
      count: 0,
      erro: e.message,
      via: 'http'
    };
  }
}
