/** Mascara valores sensíveis em URLs e textos (sem expor cookies/tokens). */

const SENSIVEL_NOME = /^(p_request|p_instance|p_salt|p_t01|session|token|auth|key|secret|csrf|sid|jsessionid|x-)/i;
const HEX_LONGO = /^[a-f0-9]{20,}$/i;
const BASE64_LONGO = /^[A-Za-z0-9+/=_-]{32,}$/;

export function mascararValor(val) {
  const s = String(val ?? '');
  if (!s) return s;
  if (s.length <= 8) return s;
  if (HEX_LONGO.test(s) || BASE64_LONGO.test(s)) {
    return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`;
  }
  if (s.length > 48) {
    return `${s.slice(0, 12)}…${s.slice(-6)} (${s.length} chars)`;
  }
  return s;
}

export function mascararUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  try {
    const u = new URL(urlStr);
    const params = {};
    for (const [k, v] of u.searchParams.entries()) {
      params[k] = SENSIVEL_NOME.test(k) || v.length > 24 ? mascararValor(v) : v;
    }
    return {
      mascarada: `${u.protocol}//${u.host}${u.pathname}?${Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&')}`,
      protocolo: u.protocol.replace(':', ''),
      host: u.host,
      path: u.pathname,
      parametros: params
    };
  } catch {
    return { mascarada: mascararValor(urlStr), parse_erro: true };
  }
}

export function compararUrls(urlApex, urlPublica) {
  const a = mascararUrl(urlApex);
  const b = mascararUrl(urlPublica);
  if (!a?.path || !b?.path) {
    return { mesmo_host: false, mesmo_path: false, diff_parametros: [] };
  }
  const keysA = new Set(Object.keys(a.parametros || {}));
  const keysB = new Set(Object.keys(b.parametros || {}));
  const soA = [...keysA].filter((k) => !keysB.has(k));
  const soB = [...keysB].filter((k) => !keysA.has(k));
  const diffValor = [...keysA].filter((k) => keysB.has(k) && a.parametros[k] !== b.parametros[k]);
  return {
    mesmo_protocolo: a.protocolo === b.protocolo,
    mesmo_host: a.host === b.host,
    mesmo_path: a.path === b.path,
    path_apex: a.path,
    path_publico: b.path,
    parametros_so_apex: soA,
    parametros_so_publico: soB,
    parametros_valor_diferente: diffValor,
    url_apex_mascarada: a.mascarada,
    url_publica_mascarada: b.mascarada
  };
}

/** Extrai itens APEX de resposta wwv_flow.ajax sem logar segredos. */
export function extrairItensAjax(texto) {
  if (!texto || typeof texto !== 'string') return { items: [], erro: 'vazio' };
  const out = [];
  try {
    const j = JSON.parse(texto);
    const items = j.items || j.regions || [];
    if (Array.isArray(items)) {
      for (const it of items) {
        const id = it.id || it.n || it.name;
        if (!id) continue;
        if (id === 'P6_RESULTADO_REMUNERACAO') {
          const v = String(it.value ?? it.v ?? '');
          out.push({
            id,
            tamanho_bytes: Buffer.byteLength(v, 'utf8'),
            preview: v.slice(0, 80).replace(/\s+/g, ' '),
            parece_json: v.trim().startsWith('{') || v.trim().startsWith('[')
          });
        } else if (id === 'P6_REQUEST_URL_REMUNERACAO') {
          const v = String(it.value ?? it.v ?? '');
          out.push({ id, url: mascararUrl(v) });
        } else if (/^P6_/.test(id)) {
          out.push({ id, valor_mascarado: mascararValor(String(it.value ?? it.v ?? '')) });
        }
      }
    }
    return { items: out, status: j.status, success: j.success ?? j.s };
  } catch {
    // APEX às vezes retorna texto parcial ou múltiplos JSON
    const hits = [];
    for (const id of ['P6_REQUEST_URL_REMUNERACAO', 'P6_RESULTADO_REMUNERACAO']) {
      const re = new RegExp(`"${id}"[^}]*"value"\\s*:\\s*"([^"\\\\]|\\\\.)*"`, 'i');
      const m = texto.match(re);
      if (m) hits.push({ id, encontrado: true, tamanho_match: m[0].length });
    }
    return { items: hits, parse_json_falhou: true, tamanho_resposta: texto.length };
  }
}
