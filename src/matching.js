/**
 * Motor de matching RH ↔ GIAP.
 * Busca agressiva + associação conservadora.
 *
 * GIAP: busca por PREFIXO (startsWith); nomes longos podem retornar [].
 */
import {
  normalizarNome,
  normalizarCPF,
  tokensNome,
  fundirTokensCurtos,
  nomeCasaPermissivo,
  similaridadeNome,
  parseDataBR,
  SUFIXOS_IGNORADOS,
  normalizarRespostaLista
} from './utils.js';

const CODIGO_ORGAO_SEMCAS = process.env.GIAP_CODIGO_ORGAO || '9';
const LOTACAO_SEMCAS = 'SEMCAS';
const PARTICULAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'DI', 'DU']);

export const CLASSIFICACAO = {
  SEGURO: 'MATCH_SEGURO',
  PROVAVEL: 'MATCH_PROVAVEL',
  DIVERGENCIA: 'DIVERGENCIA_CADASTRAL',
  SEM_MATCH: 'SEM_MATCH'
};

export function nomeGiapTemPrefixo(nomeGiap, termo) {
  const n = normalizarNomeGiap(nomeGiap) || '';
  const t = normalizarNomeGiap(termo) || String(termo || '').trim().toUpperCase();
  if (!t) return false;
  return n.startsWith(t);
}

export function chaveConsultaGiap(termo, org) {
  const t = normalizarNomeGiap(termo) || String(termo || '').trim().toUpperCase();
  return `${t}|org:${org ?? ''}`;
}

/** Mapa prefixo → quantos candidatos RH cobre (peso por especificidade). */
export function calcularCoberturaPrefixos(pendentes) {
  const freq = new Map();
  const add = (prefix, peso = 1) => {
    const v = String(prefix || '').trim().toUpperCase();
    if (v.length >= 3) freq.set(v, (freq.get(v) || 0) + peso);
  };
  for (const p of pendentes || []) {
    const nomeBase = p.historico?.funcionario || p.nome;
    const sig = tokensSignificativos(nomeBase);
    if (!sig.length) continue;
    add(sig[0], 3);
    if (sig.length >= 2) add([sig[0], sig[1]].join(' '), 2);
    if (sig.length >= 3) add(sig.slice(0, 3).join(' '), 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([prefixo, candidatos_rh]) => ({ prefixo, candidatos_rh }));
}

export function maxVariantesNome() {
  return Math.max(1, Number(process.env.GIAP_MAX_VARIANTES_NOME || 4));
}

export function normalizarNomeGiap(nome) {
  if (!nome) return null;
  let n = normalizarNome(nome);
  if (!n) return null;
  return n.replace(/\bJUNIOR\b/g, 'JR').replace(/\s+/g, ' ').trim();
}

export function tokensSignificativos(nome) {
  return fundirTokensCurtos(tokensNome(nome)).filter(
    (t) => !PARTICULAS.has(t) && !SUFIXOS_IGNORADOS.has(t)
  );
}

/**
 * Estratégias progressivas para busca por prefixo no GIAP.
 * Máximo configurável via GIAP_MAX_VARIANTES_NOME (padrão 4).
 */
export function estrategiasBuscaProgressiva(nome, max = null) {
  const limite = max != null ? max : maxVariantesNome();
  const completo = fundirTokensCurtos(tokensNome(nome));
  const sig = tokensSignificativos(nome);
  if (!sig.length) return completo.length ? [completo.join(' ')] : [];

  const out = [];
  const addTokens = (arr, minTokens = 2) => {
    if (!arr?.length || arr.length < minTokens) return;
    const s = arr.join(' ').trim();
    if (s.length >= 3 && !out.includes(s)) out.push(s);
  };

  addTokens(completo, 2);
  addTokens(sig, 2);

  const first = sig[0];
  const last = sig[sig.length - 1];

  addTokens([first, last], 2);
  if (sig.length >= 3) addTokens([first, ...sig.slice(-2)], 3);

  const sobrenomes = sig.slice(1);
  if (sobrenomes.length) {
    const distintivo = [...sobrenomes].sort((a, b) => b.length - a.length)[0];
    addTokens([first, distintivo], 2);
    if (distintivo !== last) addTokens([first, distintivo, last], 3);
  }

  if (sig.length >= 4) {
    addTokens([first, sig[1], last], 3);
    addTokens([first, ...sig.slice(-2)], 3);
  }

  const semJr = sig.filter((t) => t !== 'JR');
  if (semJr.length >= 2 && semJr.length !== sig.length) {
    addTokens([semJr[0], semJr[semJr.length - 1]], 2);
  }

  // Último recurso: primeiro nome (≥5 chars), nunca como 1ª tentativa
  if (first.length >= 5 && out.length >= limite - 1 && !out.includes(first)) {
    out.push(first);
  }

  return out.slice(0, limite);
}

/** Prefixos globais deduplicados — 1 consulta GIAP por prefixo, prioriza 1º token do nome GIAP histórico. */
export function prefixosGlobaisDedup(pendentes, max = null) {
  const lim = max ?? Math.max(5, Number(process.env.GIAP_BULK_PREFIXOS_MAX || 15));
  const freq = new Map();

  const add = (prefix, peso = 1) => {
    const v = String(prefix || '').trim().toUpperCase();
    if (v.length >= 3) freq.set(v, (freq.get(v) || 0) + peso);
  };

  for (const p of pendentes || []) {
    const nomeBase = p.historico?.funcionario || p.nome;
    const sig = tokensSignificativos(nomeBase);
    if (!sig.length) continue;
    add(sig[0], 3);
    if (sig.length >= 2) add([sig[0], sig[1]].join(' '), 2);
    if (sig.length >= 3) add(sig.slice(0, 3).join(' '), 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .map(([prefix]) => prefix)
    .slice(0, lim);
}

/** codigo_orgao para busca GIAP: SEMCAS=9; cedidos/recebidos sem restrição cega. */
export function codigoOrgaoParaBusca(pendente, codigoSemcas = CODIGO_ORGAO_SEMCAS) {
  const ehCedido = pendente?.eh_cedido || pendente?.grupo_historico === 'D';
  if (ehCedido) {
    const orgHist = pendente?.historico?.codigo_orgao;
    return orgHist != null && orgHist !== '' ? String(orgHist) : '';
  }
  return String(codigoSemcas);
}

/** @deprecated alias — use prefixosGlobaisDedup */
export function prefixosBuscaPendentes(pendentes, max = null) {
  return prefixosGlobaisDedup(pendentes, max);
}

export function matKey(m) {
  if (m == null || m === '') return '';
  const digits = String(m).replace(/\D/g, '');
  const s = digits || String(m).trim();
  const stripped = s.replace(/^0+/, '');
  return stripped || '0';
}

export function ehFolhaSemcas(item) {
  return (
    String(item?.lotacao || '').toUpperCase().trim() === LOTACAO_SEMCAS ||
    String(item?.codigo_orgao ?? '') === String(CODIGO_ORGAO_SEMCAS)
  );
}

export function matLiberada(matsOk, matricula) {
  if (!matsOk?.size) return false;
  const k = matKey(matricula);
  return !!(k && matsOk.has(k));
}

export function elegivelParaFolha(item, matsCedidos = new Set()) {
  return ehFolhaSemcas(item) || matLiberada(matsCedidos, item.matricula);
}

function admissaoCompativel(pendente, itemGiap) {
  if (!pendente.data_admissao || !itemGiap.admissao) return null;
  const admRh = String(pendente.data_admissao).slice(0, 10);
  const admGiap = parseDataBR(itemGiap.admissao) || String(itemGiap.admissao).slice(0, 10);
  if (!admRh || !admGiap) return null;
  return admRh === admGiap;
}

/**
 * Avalia correspondência RH ↔ GIAP com hierarquia:
 * matrícula → CPF → nome → dados auxiliares → similaridade.
 */
export function avaliarMatch(pendente, itemGiap, opts = {}) {
  const matsCedidos = opts.matsCedidos || new Set();
  const ehCedido =
    opts.ehCedido ||
    (pendente.funcionario_id && opts.cedidosIds?.has(pendente.funcionario_id)) ||
    (pendente.matricula && matsCedidos.has(matKey(pendente.matricula)));

  const base = {
    sim: 0,
    casa: false,
    fatores: [],
    conflitos: [],
    matRh: null,
    matGiap: null
  };

  if (!elegivelParaFolha(itemGiap, matsCedidos)) {
    return { ...base, classificacao: CLASSIFICACAO.SEM_MATCH, motivo: 'fora_semcas_cedidos' };
  }

  const nomeRh = pendente.nome;
  const nomeGiap = itemGiap.funcionario;
  const sim = similaridadeNome(nomeRh, nomeGiap);
  const casa = nomeCasaPermissivo(nomeRh, nomeGiap);
  const nomeCompat = casa || sim >= 0.85;

  base.sim = sim;
  base.casa = casa;

  const matRh = pendente.matricula ? matKey(pendente.matricula) : null;
  const matGiap = itemGiap.matricula ? matKey(itemGiap.matricula) : null;
  const matHist = pendente.historico?.matricula ? matKey(pendente.historico.matricula) : null;
  base.matRh = matRh;
  base.matGiap = matGiap;

  const cpfRh = pendente.cpf ? normalizarCPF(pendente.cpf) : null;
  const cpfGiap = itemGiap.cpf ? normalizarCPF(itemGiap.cpf) : null;
  const cpfHist = pendente.historico?.cpf ? normalizarCPF(pendente.historico.cpf) : null;

  // Âncora histórica: matrícula/CPF de competência anterior confirma identidade
  if (matHist && matGiap && matHist === matGiap) {
    const nomeHistOk =
      !pendente.historico?.funcionario ||
      nomeCasaPermissivo(pendente.historico.funcionario, nomeGiap) ||
      similaridadeNome(pendente.historico.funcionario, nomeGiap) >= 0.85;
    if (nomeHistOk || nomeCompat || ehCedido) {
      return {
        ...base,
        classificacao: CLASSIFICACAO.SEGURO,
        motivo: 'historico_matricula_confere',
        fatores: ['historico_matricula_ok', nomeHistOk ? 'nome_historico_ok' : 'nome_rh_ok'].filter(Boolean)
      };
    }
  }

  if (cpfHist && cpfGiap && cpfHist === cpfGiap && (nomeCompat || nomeCasaPermissivo(pendente.historico?.funcionario, nomeGiap))) {
    return {
      ...base,
      classificacao: CLASSIFICACAO.SEGURO,
      motivo: 'historico_cpf_confere',
      fatores: ['historico_cpf_ok', 'nome_compativel']
    };
  }

  const admOk = admissaoCompativel(pendente, itemGiap);
  const admConflito = admOk === false;

  // Conflitos de identidade → divergência cadastral (não gravar)
  if (matRh && matGiap && matRh !== matGiap) {
    if (nomeCompat || casa) {
      return {
        ...base,
        classificacao: CLASSIFICACAO.DIVERGENCIA,
        motivo: 'matricula_divergente',
        conflitos: ['matricula'],
        fatores: ['nome_parecido', 'matricula_divergente']
      };
    }
    return { ...base, classificacao: CLASSIFICACAO.SEM_MATCH, motivo: 'matricula_divergente' };
  }

  if (cpfRh && cpfGiap && cpfRh !== cpfGiap) {
    if (nomeCompat || casa) {
      return {
        ...base,
        classificacao: CLASSIFICACAO.DIVERGENCIA,
        motivo: 'cpf_divergente',
        conflitos: ['cpf'],
        fatores: ['nome_parecido', 'cpf_divergente']
      };
    }
    return { ...base, classificacao: CLASSIFICACAO.SEM_MATCH, motivo: 'cpf_divergente' };
  }

  if (admConflito && (casa || sim >= 0.88)) {
    return {
      ...base,
      classificacao: CLASSIFICACAO.DIVERGENCIA,
      motivo: 'admissao_divergente',
      conflitos: ['admissao'],
      fatores: ['nome_parecido', 'admissao_divergente']
    };
  }

  // MATCH_SEGURO
  if (matRh && matGiap && matRh === matGiap && (nomeCompat || ehCedido)) {
    return {
      ...base,
      classificacao: CLASSIFICACAO.SEGURO,
      motivo: 'matricula_confere',
      fatores: ['matricula_ok', nomeCompat ? 'nome_compativel' : 'cedido'].filter(Boolean)
    };
  }

  if (cpfRh && cpfGiap && cpfRh === cpfGiap && nomeCompat) {
    return {
      ...base,
      classificacao: CLASSIFICACAO.SEGURO,
      motivo: 'cpf_confere',
      fatores: ['cpf_ok', 'nome_compativel']
    };
  }

  if ((casa || sim >= 0.92) && !admConflito) {
    const fatores = [casa ? 'nome_casa' : 'nome_alta_sim'];
    if (admOk) fatores.push('admissao_ok');
    if (ehCedido) fatores.push('cedido');
    return {
      ...base,
      classificacao: CLASSIFICACAO.SEGURO,
      motivo: 'nome_forte_auxiliares',
      fatores
    };
  }

  // MATCH_PROVAVEL — sem conflito, mas evidência mais fraca
  if (nomeCompat && !admConflito) {
    return {
      ...base,
      classificacao: CLASSIFICACAO.PROVAVEL,
      motivo: 'nome_semelhante',
      fatores: [casa ? 'nome_casa' : 'nome_sim', admOk ? 'admissao_ok' : null].filter(Boolean)
    };
  }

  return { ...base, classificacao: CLASSIFICACAO.SEM_MATCH, motivo: 'nome_insuficiente' };
}

/** Compat: score numérico derivado da classificação. */
export function calcularScoreMatch(pendente, itemGiap, opts = {}) {
  const r = avaliarMatch(pendente, itemGiap, opts);
  const map = {
    [CLASSIFICACAO.SEGURO]: 95,
    [CLASSIFICACAO.PROVAVEL]: 78,
    [CLASSIFICACAO.DIVERGENCIA]: 50,
    [CLASSIFICACAO.SEM_MATCH]: 0
  };
  return {
    ...r,
    score: map[r.classificacao] ?? 0,
    nivel:
      r.classificacao === CLASSIFICACAO.SEGURO
        ? 'seguro'
        : r.classificacao === CLASSIFICACAO.PROVAVEL
          ? 'provavel'
          : 'rejeitado'
  };
}

/** Grava em folha_pmsl somente associação conservadora. */
export function deveGravarMatch(resultado) {
  if (!resultado) return false;
  const c = resultado.classificacao || resultado.nivel;
  if (c === CLASSIFICACAO.SEGURO || c === 'seguro') return true;
  if (c === CLASSIFICACAO.PROVAVEL || c === 'provavel') {
    if (resultado.conflitos?.length) return false;
    return (
      resultado.fatores?.includes('matricula_ok') ||
      resultado.fatores?.includes('cpf_ok')
    );
  }
  return false;
}

export function classificarPendentes(pendentes, cedencias = { ids: new Set(), mats: new Set() }) {
  const A = [];
  const B = [];
  const C = [];
  const D = [];

  for (const p of pendentes) {
    const ehCedido =
      cedencias.ids.has(p.funcionario_id) ||
      (p.matricula && cedencias.mats.has(matKey(p.matricula)));
    const sig = tokensSignificativos(p.nome);

    if (ehCedido) D.push({ ...p, grupo: 'D', eh_cedido: true });
    else if (p.tem_matricula && p.matricula) A.push({ ...p, grupo: 'A' });
    else if (sig.length >= 2) B.push({ ...p, grupo: 'B' });
    else C.push({ ...p, grupo: 'C' });
  }

  return { A, B, C, D, ordem: [...A, ...B, ...D, ...C] };
}

export class GiapBulkIndex {
  constructor() {
    this.itens = [];
    this.porMat = new Map();
    this.porCpf = new Map();
    this.porNomeNorm = new Map();
    this.porPrimeiroToken = new Map();
  }

  addItems(data, fonte = 'bulk') {
    const { lista, erro } = normalizarRespostaLista(data);
    if (erro) {
      throw new Error(`GiapBulkIndex.addItems: ${erro}`);
    }
    for (const raw of lista) {
      if (!raw) continue;
      const item = { ...raw, _fonte: fonte };
      const k = `${matKey(item.matricula)}|${normalizarNomeGiap(item.funcionario)}`;
      if (this.itens.some((x) => `${matKey(x.matricula)}|${normalizarNomeGiap(x.funcionario)}` === k)) {
        continue;
      }
      this.itens.push(item);
      const mk = matKey(item.matricula);
      if (mk) {
        if (!this.porMat.has(mk)) this.porMat.set(mk, []);
        this.porMat.get(mk).push(item);
      }
      const cpf = normalizarCPF(item.cpf);
      if (cpf) {
        if (!this.porCpf.has(cpf)) this.porCpf.set(cpf, []);
        this.porCpf.get(cpf).push(item);
      }
      const nn = normalizarNomeGiap(item.funcionario);
      if (nn) {
        if (!this.porNomeNorm.has(nn)) this.porNomeNorm.set(nn, []);
        this.porNomeNorm.get(nn).push(item);
      }
      const ft = tokensSignificativos(item.funcionario)[0];
      if (ft) {
        if (!this.porPrimeiroToken.has(ft)) this.porPrimeiroToken.set(ft, []);
        this.porPrimeiroToken.get(ft).push(item);
      }
    }
  }

  /** GIAP usa prefixo startsWith — filtra itens já indexados. */
  filtrarPorPrefixoGiap(termo, codigoOrgao = null) {
    const t = normalizarNomeGiap(termo) || String(termo || '').trim().toUpperCase();
    if (!t) return [];
    return this.itens.filter((item) => {
      if (codigoOrgao != null && codigoOrgao !== '' && String(item.codigo_orgao ?? '') !== String(codigoOrgao)) {
        return false;
      }
      return nomeGiapTemPrefixo(item.funcionario, t);
    });
  }

  candidatosPara(pendente) {
    const out = new Map();
    const add = (item) => {
      const k = `${matKey(item.matricula)}|${normalizarNomeGiap(item.funcionario)}`;
      if (!out.has(k)) out.set(k, item);
    };

    if (pendente.matricula) {
      for (const item of this.porMat.get(matKey(pendente.matricula)) || []) add(item);
    }
    if (pendente.cpf) {
      const cpf = normalizarCPF(pendente.cpf);
      for (const item of this.porCpf.get(cpf) || []) add(item);
    }
    if (pendente.historico?.matricula) {
      for (const item of this.porMat.get(matKey(pendente.historico.matricula)) || []) add(item);
    }
    if (pendente.historico?.cpf) {
      const cpfH = normalizarCPF(pendente.historico.cpf);
      for (const item of this.porCpf.get(cpfH) || []) add(item);
    }
    if (pendente.historico?.funcionario) {
      const nh = normalizarNomeGiap(pendente.historico.funcionario);
      for (const item of this.porNomeNorm.get(nh) || []) add(item);
    }
    const nn = normalizarNomeGiap(pendente.nome);
    if (nn) {
      for (const item of this.porNomeNorm.get(nn) || []) add(item);
    }
    const ft = tokensSignificativos(pendente.nome)[0];
    if (ft) {
      for (const item of this.porPrimeiroToken.get(ft) || []) add(item);
    }
    return [...out.values()];
  }

  get size() {
    return this.itens.length;
  }
}

export class GiapSearchCache {
  constructor() {
    this.porTermo = new Map();
    this.vazios = new Set();
    this.resolvidos = new Set();
    this.hits = 0;
  }

  getConsulta(termo, org) {
    const k = chaveConsultaGiap(termo, org);
    const hit = this.porTermo.get(k);
    if (hit) this.hits++;
    return hit || null;
  }

  setConsulta(termo, org, payload) {
    const k = chaveConsultaGiap(termo, org);
    this.porTermo.set(k, payload);
    if (payload?.data?.length) this.vazios.delete(k);
  }

  marcarConsultaVazia(termo, org) {
    this.vazios.add(chaveConsultaGiap(termo, org));
  }

  consultaVazia(termo, org) {
    return this.vazios.has(chaveConsultaGiap(termo, org));
  }

  /** Filtra resultado de prefixo mais curto já em cache (ex: MARIA → MARIA SILVA). */
  filtrarDePrefixoPai(termo, org) {
    const t = normalizarNomeGiap(termo) || String(termo || '').trim().toUpperCase();
    if (!t) return null;
    let melhor = null;
    for (const [key, val] of this.porTermo.entries()) {
      if (!key.endsWith(`|org:${org ?? ''}`)) continue;
      const prefix = key.slice(0, key.indexOf('|org:'));
      if (prefix.length >= t.length || !t.startsWith(prefix)) continue;
      const data = (val.data || []).filter((item) => nomeGiapTemPrefixo(item.funcionario, t));
      if (!data.length && (val.data || []).length > 0) continue;
      if (!melhor || prefix.length > melhor.prefixLen) {
        melhor = { data, origem: `cache_filtro:${prefix}`, prefixLen: prefix.length };
      }
    }
    return melhor;
  }

  /** @deprecated use getConsulta */
  get(termo) {
    const k = normalizarNomeGiap(termo) || String(termo || '').trim().toUpperCase();
    const hit = this.porTermo.get(k);
    if (hit) this.hits++;
    return hit || null;
  }

  /** @deprecated use setConsulta */
  set(termo, payload) {
    const k = normalizarNomeGiap(termo) || String(termo || '').trim().toUpperCase();
    this.porTermo.set(k, payload);
  }

  marcarResolvido(funcionarioId) {
    if (funcionarioId) this.resolvidos.add(funcionarioId);
  }

  jaResolvido(funcionarioId) {
    return this.resolvidos.has(funcionarioId);
  }
}

export function letrasNecessariasPendentes(pendentes) {
  const letras = new Set();
  for (const p of pendentes || []) {
    const ft = tokensSignificativos(p.nome)[0];
    if (ft?.[0]) letras.add(ft[0].toUpperCase());
  }
  return [...letras].sort();
}

export function matchPendenteNoIndice(pendente, indice, opts = {}) {
  const matsCedidos = opts.matsCedidos || new Set();
  const cedidosIds = opts.cedidosIds || new Set();
  const ehCedido =
    opts.ehCedido ||
    cedidosIds.has(pendente.funcionario_id) ||
    (pendente.matricula && matsCedidos.has(matKey(pendente.matricula)));

  const candidatos = indice.candidatosPara(pendente);
  if (!candidatos.length) return null;

  let melhor = null;
  let melhorAval = null;
  for (const cand of candidatos) {
    const av = avaliarMatch(pendente, cand, { matsCedidos, cedidosIds, ehCedido });
    const prio = {
      [CLASSIFICACAO.SEGURO]: 4,
      [CLASSIFICACAO.PROVAVEL]: 3,
      [CLASSIFICACAO.DIVERGENCIA]: 2,
      [CLASSIFICACAO.SEM_MATCH]: 1
    };
    const cur = prio[av.classificacao] || 0;
    const best = melhorAval ? prio[melhorAval.classificacao] || 0 : 0;
    if (cur > best || (cur === best && (av.sim || 0) > (melhorAval?.sim || 0))) {
      melhor = cand;
      melhorAval = av;
    }
  }

  if (!melhor || !melhorAval) return null;
  return { item: melhor, avaliacao: melhorAval, classificacao: melhorAval.classificacao };
}

export function cruzarComIndice(pendentes, indice, opts = {}) {
  const matsCedidos = opts.matsCedidos || new Set();
  const cedidosIds = opts.cedidosIds || new Set();
  const matches = [];
  const divergencias = [];
  const restantes = [];
  const stats = {
    tentativas: 0,
    matches_seguros: 0,
    matches_provaveis: 0,
    divergencias: 0,
    sem_match: 0,
    chamadas_giap_evitadas: pendentes.length
  };

  for (const pendente of pendentes) {
    const ehCedido =
      cedidosIds.has(pendente.funcionario_id) ||
      (pendente.matricula && matsCedidos.has(matKey(pendente.matricula)));
    const candidatos = indice.candidatosPara(pendente);
    let melhor = null;
    let melhorAval = null;

    for (const cand of candidatos) {
      stats.tentativas++;
      const av = avaliarMatch(pendente, cand, { matsCedidos, cedidosIds, ehCedido });
      const prio = {
        [CLASSIFICACAO.SEGURO]: 4,
        [CLASSIFICACAO.PROVAVEL]: 3,
        [CLASSIFICACAO.DIVERGENCIA]: 2,
        [CLASSIFICACAO.SEM_MATCH]: 1
      };
      const cur = prio[av.classificacao] || 0;
      const best = melhorAval ? prio[melhorAval.classificacao] || 0 : 0;
      if (cur > best || (cur === best && (av.sim || 0) > (melhorAval?.sim || 0))) {
        melhor = cand;
        melhorAval = av;
      }
    }

    if (melhorAval?.classificacao === CLASSIFICACAO.DIVERGENCIA) {
      stats.divergencias++;
      divergencias.push({
        pendente,
        item: melhor,
        avaliacao: melhorAval,
        estrategia: 'bulk_indice_local'
      });
      restantes.push(pendente);
    } else if (melhor && melhorAval && deveGravarMatch(melhorAval)) {
      if (melhorAval.classificacao === CLASSIFICACAO.SEGURO) stats.matches_seguros++;
      else stats.matches_provaveis++;
      matches.push({
        pendente,
        item: melhor,
        score: melhorAval,
        classificacao: melhorAval.classificacao,
        estrategia: 'bulk_indice_local',
        fonte: melhor._fonte || 'bulk'
      });
    } else {
      stats.sem_match++;
      restantes.push(pendente);
    }
  }

  return { matches, divergencias, restantes, stats };
}

export function criarStatsBusca() {
  return {
    total_rh: 0,
    total_pendentes: 0,
    bulk_bruto: 0,
    bulk_util: 0,
    registros_giap: 0,
    registros_indexados: 0,
    matches_rh: 0,
    registros_importados: 0,
    orgao_bruto: 0,
    orgao_SEMCAS: 0,
    orgao_matches_rh: 0,
    orgao_matches_matricula: 0,
    orgao_matches_nome: 0,
    orgao_recebidos: 0,
    orgao_descartados: 0,
    orgao_inseridos: 0,
    tempo_orgao_ms: 0,
    bulk_matches: 0,
    bulk_inseridos: 0,
    pendentes_iniciais: 0,
    buscas_nome: 0,
    tentativas_nome: 0,
    matches_nome: 0,
    matches_seguros: 0,
    matches_provaveis: 0,
    divergencias: 0,
    rejeitados: 0,
    sem_match: 0,
    historico_encontrado: 0,
    historico_com_matricula: 0,
    historico_com_cpf: 0,
    historico_com_nome: 0,
    historico_sem_matricula: 0,
    sem_historico: 0,
    grupo_A: 0,
    grupo_B: 0,
    grupo_C: 0,
    grupo_D: 0,
    grupo_E: 0,
    resultados_por_historico: 0,
    resultados_por_bulk: 0,
    resultados_por_nome: 0,
    resultados_por_prefixo: 0,
    chamadas_giap_evitadas_historico: 0,
    chamadas_giap_evitadas_matching_local: 0,
    cedidos_processados: 0,
    chamadas_giap_evitadas: 0,
    tempo_bulk_ms: 0,
    tempo_nomes_ms: 0,
    tempo_total_ms: 0,
    estrategias: {},
    letras: [],
    prefixos: [],
    prefixos_unicos: 0,
    consultas_giap_prefixo: 0
  };
}

export function registrarEstrategia(stats, nome, encontrou, duracaoMs) {
  if (!stats.estrategias[nome]) {
    stats.estrategias[nome] = {
      estrategia: nome,
      tentativas: 0,
      encontrados: 0,
      tempo_total_ms: 0
    };
  }
  const e = stats.estrategias[nome];
  e.tentativas++;
  if (encontrou) e.encontrados++;
  e.tempo_total_ms += duracaoMs || 0;
}

export function resumoEstrategias(stats) {
  const lista = Object.values(stats.estrategias || {}).map((e) => ({
    estrategia: e.estrategia,
    tentativas: e.tentativas,
    encontrados: e.encontrados,
    tempo_medio_ms: e.tentativas ? Math.round(e.tempo_total_ms / e.tentativas) : 0,
    taxa_sucesso: e.tentativas ? Math.round((e.encontrados / e.tentativas) * 1000) / 10 : 0
  }));
  lista.sort((a, b) => b.taxa_sucesso - a.taxa_sucesso || b.encontrados - a.encontrados);
  return lista;
}
