/**
 * Motor de matching RH ↔ GIAP.
 *
 * Comportamento do portal (evidência em scraper + teste-limite.mjs):
 * - P6_NOME_SERVIDOR: busca por PREFIXO (startsWith / LIKE 'termo%'), não igualdade.
 * - Nome em MAIÚSCULAS; acentos removidos no envio.
 * - quantidade limita a ~100 registros por consulta.
 * - Nome vazio retorna lote geral (usado no sync órgão).
 * - codigo_orgao no request zera resposta — filtro é pós-scrape.
 * - Sem resultado: JSON [] ou timeout → { data: [], raw: '' }.
 * - Nomes muito longos costumam retornar vazio; prefixos curtos (2+ tokens) funcionam melhor.
 */
import {
  normalizarNome,
  normalizarCPF,
  tokensNome,
  fundirTokensCurtos,
  nomeCasaPermissivo,
  similaridadeNome,
  parseDataBR,
  SUFIXOS_IGNORADOS
} from './utils.js';

const CODIGO_ORGAO_SEMCAS = process.env.GIAP_CODIGO_ORGAO || '9';
const LOTACAO_SEMCAS = 'SEMCAS';

const PARTICULAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'DI', 'DU']);

/** Normalização única RH + GIAP (acentos, maiúsculas, espaços, JR/JUNIOR). */
export function normalizarNomeGiap(nome) {
  if (!nome) return null;
  let n = normalizarNome(nome);
  if (!n) return null;
  n = n
    .replace(/\bJUNIOR\b/g, 'JR')
    .replace(/\bFILHO\b/g, 'FILHO')
    .replace(/\s+/g, ' ')
    .trim();
  return n;
}

/** Tokens significativos (sem partículas nem sufixos triviais). */
export function tokensSignificativos(nome) {
  return fundirTokensCurtos(tokensNome(nome)).filter(
    (t) => !PARTICULAS.has(t) && !SUFIXOS_IGNORADOS.has(t)
  );
}

/**
 * Estratégias de busca progressiva (mín. 2 tokens, exceto último recurso).
 * Ordem: completo → sem partículas → primeiro+último → primeiro+2 últimos → distintivo → combos.
 */
export function estrategiasBuscaProgressiva(nome) {
  const completo = fundirTokensCurtos(tokensNome(nome));
  const sig = tokensSignificativos(nome);
  if (!sig.length) return completo.length ? [completo.join(' ')] : [];

  const out = [];
  const addTokens = (arr, minTokens = 2) => {
    if (!arr?.length) return;
    if (arr.length < minTokens) return;
    const s = arr.join(' ').trim();
    if (s.length >= 3 && !out.includes(s)) out.push(s);
  };

  // 1) Nome completo (com partículas)
  addTokens(completo, 2);
  // 1b) Sem partículas
  addTokens(sig, 2);

  const first = sig[0];
  const last = sig[sig.length - 1];

  // 2) Primeiro + último sobrenome
  addTokens([first, last], 2);

  // 3) Primeiro + dois últimos
  if (sig.length >= 3) {
    addTokens([first, ...sig.slice(-2)], 3);
  }

  // 4) Primeiro + sobrenome mais distintivo (mais longo entre sobrenomes)
  const sobrenomes = sig.slice(1);
  if (sobrenomes.length) {
    const distintivo = [...sobrenomes].sort((a, b) => b.length - a.length)[0];
    addTokens([first, distintivo], 2);
    if (distintivo !== last) addTokens([first, distintivo, last], 3);
  }

  // 5) Combinações de 2–3 tokens distintivos
  if (sig.length >= 3) {
    addTokens([first, sig[1], last], 3);
    addTokens(sig.slice(0, 3), 3);
    if (sig.length >= 4) addTokens([first, ...sig.slice(-2)], 3);
    addTokens([first, sig[Math.floor(sig.length / 2)], last], 3);
  }

  // Sem sufixo JR no fim
  const semJr = sig.filter((t) => t !== 'JR');
  if (semJr.length >= 2 && semJr.length !== sig.length) {
    addTokens(semJr, 2);
    addTokens([semJr[0], semJr[semJr.length - 1]], 2);
  }

  // Último recurso: só primeiro nome (≥5 chars) — GIAP prefixo
  if (first.length >= 5 && !out.includes(first)) {
    out.push(first);
  }

  return out.slice(0, 10);
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
    String(item?.lotacao || '')
      .toUpperCase()
      .trim() === LOTACAO_SEMCAS ||
    String(item?.codigo_orgao ?? '') === String(CODIGO_ORGAO_SEMCAS)
  );
}

export function matLiberada(matsOk, matricula) {
  if (!matsOk?.size) return false;
  const k = matKey(matricula);
  return !!(k && matsOk.has(k));
}

/** Elegível para folha_pmsl: SEMCAS ou matrícula de cedido/recebido. */
export function elegivelParaFolha(item, matsCedidos = new Set()) {
  return ehFolhaSemcas(item) || matLiberada(matsCedidos, item.matricula);
}

/**
 * Score de correspondência RH ↔ GIAP.
 * >= 90 seguro | >= 75 provável | < 75 rejeitar
 */
export function calcularScoreMatch(pendente, itemGiap, opts = {}) {
  const matsCedidos = opts.matsCedidos || new Set();
  const ehCedido =
    opts.ehCedido ||
    (pendente.funcionario_id && opts.cedidosIds?.has(pendente.funcionario_id)) ||
    (pendente.matricula && matsCedidos.has(matKey(pendente.matricula)));

  if (!elegivelParaFolha(itemGiap, matsCedidos)) {
    return {
      score: 0,
      nivel: 'rejeitado',
      motivo: 'fora_semcas_cedidos',
      sim: 0
    };
  }

  const nomeRh = pendente.nome;
  const nomeGiap = itemGiap.funcionario || itemGiap.funcionario;
  const sim = similaridadeNome(nomeRh, nomeGiap);
  const casa = nomeCasaPermissivo(nomeRh, nomeGiap);

  let score = 0;
  const fatores = [];

  if (casa) {
    score += 50;
    fatores.push('nome_casa');
  } else if (sim >= 0.92) {
    score += 45;
    fatores.push('nome_alta_sim');
  } else if (sim >= 0.85) {
    score += 35;
    fatores.push('nome_boa_sim');
  } else if (sim >= 0.75) {
    score += 25;
    fatores.push('nome_sim_moderada');
  } else {
    return {
      score: 0,
      nivel: 'rejeitado',
      motivo: 'nome_insuficiente',
      sim,
      fatores
    };
  }

  const matRh = pendente.matricula ? matKey(pendente.matricula) : null;
  const matGiap = itemGiap.matricula ? matKey(itemGiap.matricula) : null;

  if (matRh && matGiap) {
    if (matRh === matGiap) {
      score += 30;
      fatores.push('matricula_ok');
    } else {
      return {
        score: 0,
        nivel: 'rejeitado',
        motivo: 'matricula_divergente',
        sim,
        fatores: ['matricula_divergente']
      };
    }
  }

  const cpfRh = pendente.cpf ? normalizarCPF(pendente.cpf) : null;
  const cpfGiap = itemGiap.cpf ? normalizarCPF(itemGiap.cpf) : null;
  if (cpfRh && cpfGiap) {
    if (cpfRh === cpfGiap) {
      score += 15;
      fatores.push('cpf_ok');
    } else {
      return {
        score: 0,
        nivel: 'rejeitado',
        motivo: 'cpf_divergente',
        sim,
        fatores: ['cpf_divergente']
      };
    }
  }

  if (pendente.data_admissao && itemGiap.admissao) {
    const admRh = String(pendente.data_admissao).slice(0, 10);
    const admGiap = parseDataBR(itemGiap.admissao) || String(itemGiap.admissao).slice(0, 10);
    if (admRh && admGiap && admRh === admGiap) {
      score += 10;
      fatores.push('admissao_ok');
    }
  }

  const tr = tokensSignificativos(nomeRh);
  const tg = tokensSignificativos(nomeGiap);
  if (tr.length && tg.length && tr[tr.length - 1] === tg[tg.length - 1]) {
    score += 5;
    fatores.push('mesmo_ultimo_sobrenome');
  }

  if (ehCedido && matGiap && matRh && matRh === matGiap) {
    score += 5;
    fatores.push('cedido_mat_ok');
  }

  let nivel = 'rejeitado';
  if (score >= 90) nivel = 'seguro';
  else if (score >= 75) nivel = 'provavel';

  return { score, nivel, sim, casa, fatores, matRh, matGiap };
}

/** Decide se grava em folha_pmsl automaticamente. */
export function deveGravarMatch(resultadoScore, pendente) {
  if (!resultadoScore || resultadoScore.nivel === 'rejeitado') return false;
  if (resultadoScore.nivel === 'seguro') return true;
  if (resultadoScore.nivel === 'provavel') {
    // Provável só com matrícula confirmada ou nome quase idêntico
    if (resultadoScore.fatores?.includes('matricula_ok')) return true;
    if (resultadoScore.sim >= 0.92 && resultadoScore.casa) return true;
  }
  return false;
}

/** Priorização A/B/C/D. */
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

    if (ehCedido) {
      D.push({ ...p, grupo: 'D', eh_cedido: true });
    } else if (p.tem_matricula && p.matricula) {
      A.push({ ...p, grupo: 'A' });
    } else if (sig.length >= 2) {
      B.push({ ...p, grupo: 'B' });
    } else {
      C.push({ ...p, grupo: 'C' });
    }
  }

  return { A, B, C, D, ordem: [...A, ...B, ...D, ...C] };
}

/** Índice em memória dos registros brutos do bulk. */
export class GiapBulkIndex {
  constructor() {
    this.itens = [];
    this.porMat = new Map();
    this.porPrimeiroToken = new Map();
  }

  addItems(data, fonte = 'bulk') {
    for (const raw of data || []) {
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
      const ft = tokensSignificativos(item.funcionario)[0];
      if (ft) {
        if (!this.porPrimeiroToken.has(ft)) this.porPrimeiroToken.set(ft, []);
        this.porPrimeiroToken.get(ft).push(item);
      }
    }
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
    const ft = tokensSignificativos(pendente.nome)[0];
    if (ft) {
      for (const item of this.porPrimeiroToken.get(ft) || []) add(item);
    }
    for (const item of this.itens) {
      const nn = normalizarNomeGiap(item.funcionario);
      const np = normalizarNomeGiap(pendente.nome);
      if (nn && np && (nn.includes(np.split(' ')[0]) || np.includes(nn.split(' ')[0]))) {
        add(item);
      }
    }
    return [...out.values()];
  }

  get size() {
    return this.itens.length;
  }
}

/** Cache de buscas GIAP por termo (mesmo job). */
export class GiapSearchCache {
  constructor() {
    this.porTermo = new Map();
    this.resolvidos = new Set();
  }

  get(termo) {
    const k = normalizarNomeGiap(termo) || String(termo || '').trim().toUpperCase();
    return this.porTermo.get(k) || null;
  }

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

/** Letras iniciais necessárias a partir dos pendentes (evita 26 scrapes fixos). */
export function letrasNecessariasPendentes(pendentes) {
  const letras = new Set();
  for (const p of pendentes || []) {
    const ft = tokensSignificativos(p.nome)[0];
    if (ft?.[0]) letras.add(ft[0].toUpperCase());
  }
  return [...letras].sort();
}

/**
 * Cruza pendentes com índice bulk local (sem GIAP).
 * @returns {{ matches: Array, restantes: Array, stats: object }}
 */
export function cruzarComIndice(pendentes, indice, opts = {}) {
  const matsCedidos = opts.matsCedidos || new Set();
  const cedidosIds = opts.cedidosIds || new Set();
  const matches = [];
  const restantes = [];
  const stats = {
    tentativas: 0,
    matches_seguros: 0,
    matches_provaveis: 0,
    rejeitados: 0
  };

  for (const pendente of pendentes) {
    const ehCedido =
      cedidosIds.has(pendente.funcionario_id) ||
      (pendente.matricula && matsCedidos.has(matKey(pendente.matricula)));
    const candidatos = indice.candidatosPara(pendente);
    let melhor = null;
    let melhorScore = null;

    for (const cand of candidatos) {
      stats.tentativas++;
      const sc = calcularScoreMatch(pendente, cand, {
        matsCedidos,
        cedidosIds,
        ehCedido
      });
      if (sc.score > (melhorScore?.score || 0)) {
        melhor = cand;
        melhorScore = sc;
      }
    }

    if (melhor && melhorScore && deveGravarMatch(melhorScore, pendente)) {
      if (melhorScore.nivel === 'seguro') stats.matches_seguros++;
      else stats.matches_provaveis++;
      matches.push({
        pendente,
        item: melhor,
        score: melhorScore,
        estrategia: 'bulk_indice_local',
        fonte: melhor._fonte || 'bulk'
      });
    } else {
      if (melhorScore && melhorScore.nivel === 'provavel') stats.rejeitados++;
      else if (melhorScore && melhorScore.nivel === 'rejeitado') stats.rejeitados++;
      restantes.push(pendente);
    }
  }

  return { matches, restantes, stats };
}

export function criarStatsBusca() {
  return {
    total_rh: 0,
    bulk_bruto: 0,
    bulk_util: 0,
    bulk_matches: 0,
    pendentes_iniciais: 0,
    buscas_nome: 0,
    tentativas_nome: 0,
    matches_nome: 0,
    matches_seguros: 0,
    matches_provaveis: 0,
    rejeitados: 0,
    sem_match: 0,
    cedidos_processados: 0,
    tempo_bulk_ms: 0,
    tempo_nomes_ms: 0,
    tempo_total_ms: 0,
    estrategias: {},
    letras: []
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
  return Object.values(stats.estrategias || {}).map((e) => ({
    estrategia: e.estrategia,
    tentativas: e.tentativas,
    encontrados: e.encontrados,
    tempo_medio_ms: e.tentativas ? Math.round(e.tempo_total_ms / e.tentativas) : 0,
    taxa_sucesso: e.tentativas ? Math.round((e.encontrados / e.tentativas) * 1000) / 10 : 0
  }));
}
