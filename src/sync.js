import { scrapeRemuneracoes } from './scraper.js';
import { normalizarCPF, normalizarNome, parseDataBR } from './utils.js';
import { getSupabase } from './supabase.js';

function sb() {
  return getSupabase();
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

async function logSync(payload) {
  try {
    const { error } = await sb().from('giap_sync_log').insert(payload);
    if (error) console.error('[sync] falhou ao logar:', error.message);
  } catch (err) {
    console.error('[sync] falhou ao logar:', err.message);
  }
}

/**
 * Puxa todos servidores de um órgão e faz upsert em folha_pmsl.
 */
export async function syncPorOrgao({ codigoOrgao, codigoInstituicao = 1, competencia }) {
  const inicio = Date.now();
  const log = {
    tipo: 'orgao',
    parametros: { codigoOrgao, codigoInstituicao, competencia },
    registros_encontrados: 0,
    registros_inseridos: 0
  };
  
  try {
    const { data, requestUrl } = await scrapeRemuneracoes({
      competencia,
      codigoInstituicao,
      codigoOrgao,
      quantidade: 100
    });
    
    log.registros_encontrados = data.length;
    log.parametros.request_url = requestUrl;
    
    if (data.length > 0) {
      const registros = data
        .map(transformar)
        .filter(r => r.matricula); // só persiste quem tem matrícula
      
      const { error, data: inseridos } = await sb()
        .from('folha_pmsl')
        .upsert(registros, {
          onConflict: 'competencia,matricula,codigo_instituicao'
        })
        .select('id');
      
      if (error) throw error;
      log.registros_inseridos = inseridos?.length || 0;
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
 * Puxa servidores por nome (LIKE prefix no GIAP) e persiste.
 */
export async function syncPorNome({ nomeServidor, codigoInstituicao = 1, competencia, codigoOrgao = '' }) {
  const inicio = Date.now();
  const log = {
    tipo: 'nome',
    parametros: { nomeServidor, codigoInstituicao, competencia, codigoOrgao },
    registros_encontrados: 0,
    registros_inseridos: 0
  };
  
  try {
    const { data, requestUrl } = await scrapeRemuneracoes({
      competencia,
      codigoInstituicao,
      codigoOrgao: codigoOrgao || '',
      nomeServidor,
      quantidade: 100
    });
    
    log.registros_encontrados = data.length;
    log.parametros.request_url = requestUrl;
    
    let inseridos = [];
    if (data.length > 0) {
      const registros = data.map(transformar).filter(r => r.matricula);
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
    
    log.duracao_ms = Date.now() - inicio;
    await logSync(log);
    return { success: true, resultado: inseridos, ...log };
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
