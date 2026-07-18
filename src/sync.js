import { scrapeRemuneracoes } from './scraper.js';
import {
  normalizarCPF,
  normalizarNome,
  parseDataBR,
  similaridadeNome,
  nomeCasaPermissivo,
  nomeBuscaGiap,
  variantesBuscaGiap
} from './utils.js';
import { getSupabase } from './supabase.js';

const CODIGO_ORGAO_SEMCAS = process.env.GIAP_CODIGO_ORGAO || '9';
const LOTACAO_SEMCAS = 'SEMCAS';

function sb() {
  return getSupabase();
}

function ehFolhaSemcas(item) {
  return (
    String(item?.lotacao || '')
      .toUpperCase()
      .trim() === LOTACAO_SEMCAS ||
    String(item?.codigo_orgao ?? '') === String(CODIGO_ORGAO_SEMCAS)
  );
}

function matKey(m) {
  if (m == null || m === '') return '';
  const digits = String(m).replace(/\D/g, '');
  const s = digits || String(m).trim();
  const stripped = s.replace(/^0+/, '');
  return stripped || '0';
}

function matLiberada(matsOk, matricula) {
  if (!matsOk?.size) return false;
  const k = matKey(matricula);
  return !!(k && matsOk.has(k));
}

/**
 * Converte item bruto do GIAP no formato da tabela folha_pmsl.
 */
function transformar(item) {
  return {
    competencia: item.competencia,
    codigo_instituicao: item.codigo_instituicao,
    codigo_orgao: item.codigo_orgao != null ? String(item.codigo_orgao) : null,
    lotacao: item.lotacao || null,
    matricula: item.matricula != null ? String(item.matricula) : null,
    cpf: normalizarCPF(item.cpf),
    funcionario: item.funcionario || null,
    funcionario_norm: normalizarNome(item.funcionario),
    cargo_origem: item.cargoorigem || null,
    cargo_comissionado: item.cargocomissionado || null,
    horas_semanais: item.horassemanais ?? null,
    vencimento_base: item.vencimentobase ?? null,
    proventos: item.proventos ?? null,
    descontos: item.descontos ?? null,
    liquido: item.liquido ?? null,
    admissao: parseDataBR(item.admissao),
    demissao: parseDataBR(item.demissao),
    raw_json: item,
    fetched_at: new Date().toISOString()
  };
}

/** Colunas reais de giap_sync_log — campos extras (ex.: registros_filtrados) vão pra parametros. */
const LOG_COLUNAS = [
  'tipo',
  'parametros',
  'registros_encontrados',
  'registros_inseridos',
  'registros_atualizados',
  'erro',
  'duracao_ms'
];

async function logSync(payload) {
  try {
    const row = {};
    const extras = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined) continue;
      if (LOG_COLUNAS.includes(k)) row[k] = v;
      else extras[k] = v;
    }
    if (Object.keys(extras).length) {
      row.parametros = { ...(row.parametros || {}), ...extras };
    }
    const { error } = await sb().from('giap_sync_log').insert(row);
    if (error) console.error('[sync] falhou ao logar:', error.message);
  } catch (err) {
    console.error('[sync] falhou ao logar:', err.message);
  }
}

/** Remove duplicatas da chave (competencia, matricula, codigo_instituicao) — evita "ON CONFLICT DO UPDATE cannot affect row a second time". */
function dedupePorChave(registros) {
  const m = new Map();
  for (const r of registros) {
    m.set(`${r.competencia}|${r.matricula}|${r.codigo_instituicao}`, r);
  }
  return [...m.values()];
}

/**
 * Puxa todos servidores de um órgão e faz upsert em folha_pmsl.
 */
export async function syncPorOrgao({ codigoOrgao, codigoInstituicao = 1, competencia }) {
  const inicio = Date.now();
  const log = {
    tipo: 'orgao',
    parametros: { codigoOrgao, codigoInstituicao, competencia },
    registros_encontrados: 0, // bruto do portal
    registros_filtrados: 0,   // após filtro pós-scrape por codigo_orgao
    registros_inseridos: 0
  };

  try {
    // Portal zera resposta quando codigo_orgao é enviado — filtramos pós-scrape.
    const { data, requestUrl } = await scrapeRemuneracoes({
      competencia,
      codigoInstituicao,
      quantidade: 100
    });

    log.registros_encontrados = data.length;
    log.parametros.request_url = requestUrl;

    const filtradas = codigoOrgao
      ? data.filter((r) => String(r.codigo_orgao) === String(codigoOrgao))
      : data;
    log.registros_filtrados = filtradas.length;

    if (filtradas.length > 0) {
      const registros = dedupePorChave(
        filtradas.map(transformar).filter((r) => r.matricula)
      );

      if (registros.length > 0) {
        const { error, data: inseridos } = await sb()
          .from('folha_pmsl')
          .upsert(registros, {
            onConflict: 'competencia,matricula,codigo_instituicao'
          })
          .select('id');

        if (error) throw error;
        log.registros_inseridos = inseridos?.length || 0;
      }
    }

    log.duracao_ms = Date.now() - inicio;
    await logSync(log);
    return { success: true, ...log };
  } catch (e) {
    log.erro = e.message;
    log.duracao_ms = Date.now() - inicio;
    await logSync(log);
    throw e;
  }
}

/**
 * Puxa servidores por nome e persiste.
 * @param {string} [filtrarNomeAlvo] se informado (busca de 1 pessoa), só grava
 *   quem tiver nome bem parecido — evita poluir a folha com homônimos de prefixo curto.
 * @param {boolean} [apenasSemcas=true] com alvo de nome: só grava SEMCAS, salvo
 *   matrículas em `matriculasOutrosOrgaosOk` (Cedidos/Recebidos).
 * @param {string[]} [matriculasOutrosOrgaosOk] matrículas que podem gravar fora da SEMCAS.
 */
export async function syncPorNome({
  nomeServidor,
  codigoInstituicao = 1,
  competencia,
  filtrarOrgao = null,
  filtrarNomeAlvo = null,
  similaridadeMin = 0.88,
  apenasSemcas = true,
  matriculasOutrosOrgaosOk = null,
  /** Quantas variantes de nome tentar (Puxar 1 a 1: use ≥3). */
  maxVariantes = null
} = {}) {
  const inicio = Date.now();
  const orgaoFiltro = filtrarOrgao ? String(filtrarOrgao) : null;
  const matsOk = matriculasOutrosOrgaosOk
    ? new Set(
        [...matriculasOutrosOrgaosOk]
          .map((m) => matKey(m))
          .filter(Boolean)
      )
    : null;
  const log = {
    tipo: 'nome',
    parametros: {
      nomeServidor,
      codigoInstituicao,
      competencia,
      filtrarNomeAlvo,
      filtrarOrgao: orgaoFiltro,
      apenasSemcas: !!apenasSemcas
    },
    registros_encontrados: 0,
    registros_filtrados: 0,
    registros_inseridos: 0
  };

  let rawAmostra = null;
  let nomesRetornadosAmostra = null;
  let buscaUsada = null;

  try {
    // Portal GIAP espera nome em MAIÚSCULAS (ex.: JURANDY SOARES SANTANA JUNIOR).
    // Se o completo vier vazio, tenta prefixos: JURANDY SOARES SANTANA → JURANDY SOARES…
    const qtd = 100;
    const maxVar = Math.max(
      1,
      Number(
        maxVariantes != null
          ? maxVariantes
          : process.env.GIAP_MAX_VARIANTES_NOME || 4
      )
    );
    const variantes = [];
    const addVar = (s) => {
      const v = nomeBuscaGiap(s) || (normalizarNome(s) || '').trim();
      if (v && !variantes.includes(v)) variantes.push(v);
    };
    addVar(nomeServidor);
    for (const v of variantesBuscaGiap(nomeServidor)) addVar(v);
    // Sem JUNIOR/JR no fim (às vezes o portal indexa sem sufixo)
    const tokens = (nomeBuscaGiap(nomeServidor) || '').split(' ').filter(Boolean);
    if (tokens.length >= 3) {
      const semSufixo = tokens.filter((t) => t !== 'JUNIOR' && t !== 'JR');
      if (semSufixo.length >= 2) addVar(semSufixo.join(' '));
    }

    let data = [];
    let requestUrl = null;
    let raw = '';
    for (const busca of variantes.slice(0, maxVar)) {
      buscaUsada = busca;
      const r = await scrapeRemuneracoes({
        competencia,
        codigoInstituicao,
        nomeServidor: busca,
        quantidade: qtd
      });
      data = r.data || [];
      requestUrl = r.requestUrl;
      raw = r.raw || '';
      if (data.length > 0) break;
    }

    log.registros_encontrados = data.length;
    log.parametros.request_url = requestUrl;
    log.parametros.quantidade = qtd;
    log.parametros.busca_usada = buscaUsada;
    log.parametros.variantes_tentadas = variantes.slice(0, maxVar);
    if (data.length === 0) {
      rawAmostra = String(raw || '').slice(0, 200);
    } else {
      nomesRetornadosAmostra = data.slice(0, 5).map((r) => r?.funcionario || null);
    }

    let filtradas = data;
    // Também aceita linha cuja matrícula está liberada (RH / Cedido),
    // mesmo se o filtro de nome falhar por grafia estranha no portal.
    if (filtrarNomeAlvo || matsOk?.size) {
      filtradas = data.filter((item) => {
        if (matLiberada(matsOk, item.matricula)) return true;
        if (!filtrarNomeAlvo) return false;
        return (
          nomeCasaPermissivo(item.funcionario, filtrarNomeAlvo) ||
          similaridadeNome(filtrarNomeAlvo, item.funcionario) >= similaridadeMin
        );
      });
      // SEMCAS employee ≠ homônimo de SEMOSP/SEMUS etc.
      // Outras secretarias só se matrícula liberada (RH puxado / Cedido).
      if (apenasSemcas) {
        filtradas = filtradas.filter(
          (item) => ehFolhaSemcas(item) || matLiberada(matsOk, item.matricula)
        );
      }
    }
    if (orgaoFiltro) {
      filtradas = filtradas.filter(
        (item) => String(item.codigo_orgao) === orgaoFiltro
      );
    }
    log.registros_filtrados = filtradas.length;

    let inseridos = [];
    if (filtradas.length > 0) {
      const registros = dedupePorChave(
        filtradas.map(transformar).filter((r) => r.matricula)
      );
      if (registros.length > 0) {
        const { error, data: ins } = await sb()
          .from('folha_pmsl')
          .upsert(registros, {
            onConflict: 'competencia,matricula,codigo_instituicao'
          })
          .select('id, matricula, funcionario, cpf, lotacao');
        if (error) throw error;
        inseridos = ins || [];
        log.registros_inseridos = inseridos.length;
      }
    }

    log.duracao_ms = Date.now() - inicio;
    await logSync(log);
    return {
      success: true,
      resultado: inseridos,
      raw_amostra: rawAmostra,
      nomes_retornados_amostra: nomesRetornadosAmostra,
      ...log
    };
  } catch (e) {
    log.erro = e.message;
    log.duracao_ms = Date.now() - inicio;
    await logSync(log);
    throw e;
  }
}

/**
 * Cruza folha_pmsl com uma tabela HR, aplica updates de:
 * - matricula (se HR não tiver)
 * - tipo_vinculo ('efetivo' se bateu, 'terceirizado' se não)
 * - exonerado / data_exoneracao (se demissao preenchida)
 */
export async function cruzarComHR({
  tabelaHR = 'hr_servidores',
  campoCPF = 'cpf',
  campoNome = 'nome',
  campoMatricula = 'matricula',
  campoTipoVinculo = 'tipo_vinculo',
  campoExonerado = 'exonerado',
  campoDataExoneracao = 'data_exoneracao',
  competencia,
  aplicarUpdates = true,
  filtroLotacao = null
} = {}) {
  const inicio = Date.now();
  
  // Puxa folha da competência
  let queryFolha = sb().from('folha_pmsl').select('*').eq('competencia', competencia);
  if (filtroLotacao) queryFolha = queryFolha.eq('lotacao', filtroLotacao);
  const { data: folha, error: errFolha } = await queryFolha;
  if (errFolha) throw errFolha;
  
  // Puxa HR
  const { data: hrData, error: errHR } = await sb().from(tabelaHR).select('*');
  if (errHR) throw errHR;
  
  // Índices de lookup
  const porCPF = new Map();
  const porNome = new Map();
  folha.forEach(f => {
    if (f.cpf) porCPF.set(f.cpf, f);
    if (f.funcionario_norm) {
      if (!porNome.has(f.funcionario_norm)) porNome.set(f.funcionario_norm, []);
      porNome.get(f.funcionario_norm).push(f);
    }
  });
  
  const relatorio = {
    total_hr: hrData.length,
    total_folha: folha.length,
    matched_cpf: 0,
    matched_nome: 0,
    ambiguo_nome: 0,
    sem_match: 0,
    matricula_atualizada: 0,
    marcado_efetivo: 0,
    marcado_terceirizado: 0,
    marcado_exonerado: 0,
    ambiguidades: [],
    updates_aplicados: 0,
    updates_pendentes: []
  };
  
  for (const hr of hrData) {
    const cpfNorm = normalizarCPF(hr[campoCPF]);
    const nomeNorm = normalizarNome(hr[campoNome]);
    
    let match = null;
    let tipoMatch = null;
    
    if (cpfNorm && porCPF.has(cpfNorm)) {
      match = porCPF.get(cpfNorm);
      tipoMatch = 'cpf';
    } else if (nomeNorm) {
      const cands = porNome.get(nomeNorm);
      if (cands?.length === 1) {
        match = cands[0];
        tipoMatch = 'nome';
      } else if (cands?.length > 1) {
        relatorio.ambiguo_nome++;
        relatorio.ambiguidades.push({
          hr_id: hr.id,
          nome: hr[campoNome],
          candidatos: cands.map(c => ({ matricula: c.matricula, cpf: c.cpf, lotacao: c.lotacao }))
        });
        continue;
      }
    }
    
    const patch = {};
    
    if (match) {
      if (tipoMatch === 'cpf') relatorio.matched_cpf++;
      else relatorio.matched_nome++;
      
      if (hr[campoTipoVinculo] !== 'efetivo') {
        patch[campoTipoVinculo] = 'efetivo';
        relatorio.marcado_efetivo++;
      }
      
      if (!hr[campoMatricula] && match.matricula) {
        patch[campoMatricula] = match.matricula;
        relatorio.matricula_atualizada++;
      }
      
      if (match.demissao && !hr[campoExonerado]) {
        patch[campoExonerado] = true;
        patch[campoDataExoneracao] = match.demissao;
        relatorio.marcado_exonerado++;
      }
    } else {
      relatorio.sem_match++;
      if (hr[campoTipoVinculo] !== 'terceirizado') {
        patch[campoTipoVinculo] = 'terceirizado';
        relatorio.marcado_terceirizado++;
      }
    }
    
    if (Object.keys(patch).length > 0) {
      relatorio.updates_pendentes.push({ id: hr.id, patch });
    }
  }
  
  if (aplicarUpdates && relatorio.updates_pendentes.length > 0) {
    for (const u of relatorio.updates_pendentes) {
      const { error } = await sb().from(tabelaHR).update(u.patch).eq('id', u.id);
      if (!error) relatorio.updates_aplicados++;
    }
  }
  
  relatorio.duracao_ms = Date.now() - inicio;
  
  await logSync({
    tipo: 'match_hr',
    parametros: { tabelaHR, competencia, filtroLotacao, aplicarUpdates },
    registros_encontrados: relatorio.total_hr,
    registros_atualizados: relatorio.updates_aplicados,
    duracao_ms: relatorio.duracao_ms
  });
  
  return relatorio;
}

/**
 * Compara servidores efetivos do HR com a folha da competência e marca exonerados.
 * Um servidor é considerado exonerado se:
 * - Aparece na folha com campo 'demissao' preenchido, OU
 * - Não aparece na folha da competência (tá sumido faz 2+ meses = provavelmente saiu)
 */
export async function verificarExoneracoes({
  competencia,
  tabelaHR = 'hr_servidores',
  campoMatricula = 'matricula',
  campoExonerado = 'exonerado',
  campoDataExoneracao = 'data_exoneracao',
  campoTipoVinculo = 'tipo_vinculo'
} = {}) {
  const { data: hrEfetivos, error: errHR } = await sb()
    .from(tabelaHR)
    .select(`id, ${campoMatricula}`)
    .eq(campoTipoVinculo, 'efetivo')
    .or(`${campoExonerado}.is.null,${campoExonerado}.eq.false`);
  
  if (errHR) throw errHR;
  if (!hrEfetivos?.length) return { verificados: 0, exonerados: 0 };
  
  const { data: folha, error: errFolha } = await sb()
    .from('folha_pmsl')
    .select('matricula, demissao')
    .eq('competencia', competencia);
  
  if (errFolha) throw errFolha;
  
  const demissoes = new Map();
  folha.forEach(f => {
    if (f.demissao) demissoes.set(String(f.matricula), f.demissao);
  });
  
  let exoneradosMarcados = 0;
  const detalhes = [];
  
  for (const hr of hrEfetivos) {
    const matr = String(hr[campoMatricula]);
    if (demissoes.has(matr)) {
      const dt = demissoes.get(matr);
      const { error } = await sb().from(tabelaHR).update({
        [campoExonerado]: true,
        [campoDataExoneracao]: dt
      }).eq('id', hr.id);
      if (!error) {
        exoneradosMarcados++;
        detalhes.push({ id: hr.id, matricula: matr, data: dt });
      }
    }
  }
  
  return { verificados: hrEfetivos.length, exonerados: exoneradosMarcados, detalhes };
}
