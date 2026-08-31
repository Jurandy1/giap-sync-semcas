/**
 * Adaptador RHSEMCAS: enriquecimento + exoneração a partir da folha GIAP.
 *
 * Matching (API GIAP NÃO usa CPF como chave principal):
 * 1) matrícula
 * 2) nome completo (exato)
 * 3) nome completo + data de admissão (desambiguação)
 * 4) nome muito similar + data de admissão
 *
 * Enriquecimento: preenche matrícula/admissão/nome quando o match é confiável.
 */
import {
  normalizarNome,
  similaridadeNome,
  nomeBuscaGiap,
  variantesBuscaGiap,
  variantesBuscaSemMatricula
} from './utils.js';
import { estrategiasBuscaProgressiva } from './matching.js';
import { getSupabase } from './supabase.js';

const CODIGO_ORGAO_SEMCAS = process.env.GIAP_CODIGO_ORGAO || '9';
const LOTACAO_SEMCAS = 'SEMCAS';

/** Categorias de vínculo cujos servidores aparecem na folha da Prefeitura no GIAP. */
function normalizarCategoria(c) {
  return String(c || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[\/\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Vínculos que NÃO entram na folha GIAP / sync por nome. */
const VINCULOS_EXCLUIDOS_GIAP = new Set(
  [
    'TERCEIRIZADO',
    'TERCEIRIZADA',
    'PROCAD',
    'ESTAGIARIO',
    'ESTAGIO',
    'ESTAGIÁRIO'
  ].map(normalizarCategoria)
);

/**
 * IDs elegíveis: todo ativo com lotação, exceto Terceirizado e PROCAD.
 * (Antes era whitelist restrita — deixava muita gente de fora.)
 */
async function carregarIdsElegiveisFolhaPmsl() {
  const lots = await selectTudo(() =>
    sb()
      .from('funcionario_lotacao')
      .select('id, funcionario_id, vinculo_id, ativo, data_fim')
      .eq('ativo', true)
      .order('id')
  );

  const { data: vinculos, error: errV } = await sb()
    .from('vinculos')
    .select('id, categoria');
  if (errV) throw errV;

  const catById = new Map(
    (vinculos || []).map((v) => [v.id, normalizarCategoria(v.categoria)])
  );

  const ids = new Set();
  for (const l of lots || []) {
    if (l.data_fim) continue;
    const cat = catById.get(l.vinculo_id) || '';
    // Sem categoria ou categoria excluída → fora
    if (!cat) continue;
    if (VINCULOS_EXCLUIDOS_GIAP.has(cat)) continue;
    // Também exclui se o nome da categoria contém PROCAD / TERCEIRIZ
    if (cat.includes('PROCAD') || cat.includes('TERCEIRIZ')) continue;
    ids.add(l.funcionario_id);
  }
  return ids;
}

function ehFolhaSemcas(f) {
  return (
    String(f?.lotacao || '').toUpperCase().trim() === LOTACAO_SEMCAS ||
    String(f?.codigo_orgao ?? '') === String(CODIGO_ORGAO_SEMCAS)
  );
}

/** Cedidos/Recebidos atuais — únicos que podem casar/gravar folha de outra secretaria. */
export async function carregarCedenciasAtuais() {
  const ids = new Set();
  const mats = new Set();
  try {
    const { data, error } = await sb()
      .from('v_cedencias_atuais')
      .select('funcionario_id, matricula')
      .limit(3000);
    if (error) throw error;
    for (const c of data || []) {
      if (c.funcionario_id) ids.add(c.funcionario_id);
      if (c.matricula != null && String(c.matricula).trim()) {
        mats.add(String(c.matricula).trim());
      }
    }
  } catch (e) {
    console.warn('[cedencias]', e.message);
  }
  return { ids, mats };
}

function sb() {
  return getSupabase();
}

/**
 * O Supabase corta em 1000 linhas por consulta — com 1165 ativos, o corte
 * silencioso deixava ~165 servidores fora do enriquecimento/exoneração.
 * Recebe uma fábrica de query (o builder não pode ser reutilizado entre ranges).
 */
async function selectTudo(montarQuery, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await montarQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    if (data?.length) out.push(...data);
    if (!data || data.length < pageSize) break;
  }
  return out;
}

export { nomeBuscaGiap, variantesBuscaGiap, variantesBuscaSemMatricula };

function cargoEhServicoPrestado(cargo) {
  if (!cargo) return false;
  const n = String(cargo)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  return n === 'SERVICO PRESTADO' || n.includes('SERVICO PRESTADO');
}

function matriculaVazia(m) {
  return m == null || String(m).trim() === '';
}

/** Normaliza date/ISO/string para YYYY-MM-DD */
function normalizarDataISO(d) {
  if (d == null || d === '') return null;
  const s = String(d).trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/**
 * Confere admissão RH × GIAP.
 * - Datas diferentes → 'divergente' (bloqueia).
 * - GIAP sem data → 'sem_giap' (ainda permite preencher matrícula).
 * - RH sem data → 'sem_rh' (permite preencher matrícula/admissão).
 */
function statusAdmissao(hrAdmissao, folhaAdmissao) {
  const a = normalizarDataISO(hrAdmissao);
  const b = normalizarDataISO(folhaAdmissao);
  if (a && b) return a === b ? 'ok' : 'divergente';
  if (a && !b) return 'sem_giap';
  if (!a && b) return 'sem_rh';
  return 'sem_rh';
}

/** Match tipagens que autorizam preencher matrícula/admissão vazias. */
const TIPOS_ENRIQUECER = new Set([
  'matricula',
  'nome_exato',
  'nome_admissao',
  'busca_nome',
  'nome_similar_admissao',
  'nome_similar'
]);

async function carregarFolhaSemcas(competencia) {
  return selectTudo(() =>
    sb()
      .from('folha_pmsl')
      .select('*')
      .eq('competencia', competencia)
      .or(`lotacao.eq.${LOTACAO_SEMCAS},codigo_orgao.eq.${CODIGO_ORGAO_SEMCAS}`)
      .order('id')
  );
}

/** Folha inteira da competência (inclui buscas por nome sem filtro de órgão). */
async function carregarFolhaCompetencia(competencia) {
  return selectTudo(() =>
    sb().from('folha_pmsl').select('*').eq('competencia', competencia).order('id')
  );
}

/** Prefere registro SEMCAS quando há homônimos. */
function preferirSemcas(lista) {
  if (!lista?.length) return lista || [];
  const semcas = lista.filter(ehFolhaSemcas);
  return semcas.length ? semcas : lista;
}

async function carregarFuncionariosAtivos() {
  const funcs = await selectTudo(() =>
    sb()
      .from('funcionarios')
      .select('id, nome, cpf, matricula, data_admissao, ativo')
      .eq('ativo', true)
      .order('id')
  );

  const lots = await selectTudo(() =>
    sb()
      .from('funcionario_lotacao')
      .select('id, funcionario_id, vinculo_id, ativo, data_fim')
      .eq('ativo', true)
      .order('id')
  );

  const { data: vinculos, error: errV } = await sb()
    .from('vinculos')
    .select('id, categoria');
  if (errV) throw errV;

  const vincById = new Map((vinculos || []).map((v) => [v.id, v]));
  const lotByFunc = new Map();
  for (const l of lots || []) {
    if (l.data_fim) continue;
    lotByFunc.set(l.funcionario_id, l);
  }

  const vincSp = (vinculos || []).find(
    (v) =>
      String(v.categoria || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .trim() === 'SERVICO PRESTADO'
  );

  return {
    funcionarios: funcs || [],
    lotByFunc,
    vincById,
    vinculoSpId: vincSp?.id || null
  };
}

function indexarFolha(folha) {
  const porMatricula = new Map();
  const porNome = new Map(); // nome_norm -> [itens]
  const porPrimeiro = new Map(); // 1º token -> [itens] (poda similaridade)
  for (const f of folha) {
    if (f.matricula) porMatricula.set(String(f.matricula).trim(), f);
    const nn = f.funcionario_norm || normalizarNome(f.funcionario);
    if (nn) {
      if (!porNome.has(nn)) porNome.set(nn, []);
      porNome.get(nn).push(f);
      const prim = nn.split(' ')[0];
      if (prim) {
        if (!porPrimeiro.has(prim)) porPrimeiro.set(prim, []);
        porPrimeiro.get(prim).push(f);
      }
    }
  }
  return { porMatricula, porNome, porPrimeiro, todos: folha };
}

/**
 * Match inteligente — sem CPF (portal/API não é fonte confiável de CPF aqui).
 * Prioridade: matrícula → nome exato → nome+admissão → nome similar+admissão.
 */
function encontrarMatch(hr, idx) {
  // 1) Matrícula (mais forte)
  if (!matriculaVazia(hr.matricula)) {
    const m = idx.porMatricula.get(String(hr.matricula).trim());
    if (m) return { match: m, tipo: 'matricula', confianca: 1 };
  }

  const nomeNorm = normalizarNome(hr.nome);
  if (!nomeNorm) return { match: null, tipo: 'sem_match', confianca: 0 };

  // 2) Nome completo exatamente igual (prioriza SEMCAS se houver homônimo)
  const exatos = preferirSemcas(idx.porNome.get(nomeNorm) || []);
  if (exatos.length === 1) {
    return { match: exatos[0], tipo: 'nome_exato', confianca: 0.95 };
  }
  if (exatos.length > 1) {
    // 3) Desambigua com data de admissão
    const admHr = normalizarDataISO(hr.data_admissao);
    if (admHr) {
      const comAdm = preferirSemcas(
        exatos.filter((f) => normalizarDataISO(f.admissao) === admHr)
      );
      if (comAdm.length === 1) {
        return { match: comAdm[0], tipo: 'nome_admissao', confianca: 0.98 };
      }
      if (comAdm.length > 1) {
        return { match: null, tipo: 'ambiguo', candidatos: comAdm.length, confianca: 0 };
      }
    }
    return { match: null, tipo: 'ambiguo', candidatos: exatos.length, confianca: 0 };
  }

  // 4) Nome muito similar + admissão (ex.: abreviação / ordem)
  const admHr = normalizarDataISO(hr.data_admissao);
  const candidatos = [];
  const prim = nomeNorm.split(' ')[0];
  const pool = (prim && idx.porPrimeiro.get(prim)) || idx.todos;
  for (const f of pool) {
    const sim = similaridadeNome(hr.nome, f.funcionario);
    if (sim < 0.92) continue;
    const admF = normalizarDataISO(f.admissao);
    // Sem admissão no RH: só aceita similaridade quase perfeita e nome com ≥3 tokens
    if (!admHr) {
      if (sim >= 0.98 && tokensLen(hr.nome) >= 3) {
        candidatos.push({ f, sim, comAdm: false });
      }
      continue;
    }
    if (admF && admF === admHr) {
      candidatos.push({ f, sim, comAdm: true });
    }
  }

  if (candidatos.length === 1) {
    const c = candidatos[0];
    return {
      match: c.f,
      tipo: c.comAdm ? 'nome_similar_admissao' : 'nome_similar',
      confianca: c.sim
    };
  }
  if (candidatos.length > 1) {
    // Empate: SEMCAS primeiro, depois maior similaridade
    candidatos.sort((a, b) => {
      const sa = ehFolhaSemcas(a.f) ? 1 : 0;
      const sb = ehFolhaSemcas(b.f) ? 1 : 0;
      if (sb !== sa) return sb - sa;
      return b.sim - a.sim;
    });
    if (
      candidatos[0].sim - candidatos[1].sim >= 0.03 ||
      (ehFolhaSemcas(candidatos[0].f) && !ehFolhaSemcas(candidatos[1].f))
    ) {
      const c = candidatos[0];
      return {
        match: c.f,
        tipo: c.comAdm ? 'nome_similar_admissao' : 'nome_similar',
        confianca: c.sim
      };
    }
    return { match: null, tipo: 'ambiguo', candidatos: candidatos.length, confianca: 0 };
  }

  return { match: null, tipo: 'sem_match', confianca: 0 };
}

function tokensLen(nome) {
  return (normalizarNome(nome) || '').split(' ').filter(Boolean).length;
}

/**
 * Enriquecimento dos funcionários ativos.
 */
export async function enriquecerFuncionarios({
  competencia,
  dryRun = false,
  onProgress = null,
  jobId = null,
  matchesBusca = null
} = {}) {
  // Competência inteira: buscas por nome sem órgão entram na folha e precisam casar
  const folha = await carregarFolhaCompetencia(competencia);
  const idx = indexarFolha(folha);
  const { funcionarios, lotByFunc, vincById, vinculoSpId } = await carregarFuncionariosAtivos();
  const idsElegiveis = await carregarIdsElegiveisFolhaPmsl();
  const elegiveis = funcionarios.filter((f) => idsElegiveis.has(f.id));

  const relatorio = {
    competencia,
    total_hr: funcionarios.length,
    total_elegiveis: elegiveis.length,
    total_folha: folha.length,
    matched: 0,
    via_busca_nome: 0,
    ambiguo: 0,
    sem_match: 0,
    skip_admissao: 0,
    matricula_preenchida: 0,
    nome_corrigido: 0,
    admissao_preenchida: 0,
    vinculo_sp_corrigido: 0,
    items: []
  };

  const total = elegiveis.length;
  let processados = 0;

  for (const hr of elegiveis) {
    // A busca por nome desta execução já validou a pessoa (filtro de
    // similaridade contra o nome do RH) — usa o link direto pela matrícula
    let resultado = null;
    const matBusca = matchesBusca?.get(hr.id);
    if (matBusca) {
      const viaBusca = idx.porMatricula.get(String(matBusca).trim());
      if (viaBusca) {
        resultado = { match: viaBusca, tipo: 'busca_nome', confianca: 0.9 };
        relatorio.via_busca_nome++;
      }
    }
    const { match, tipo } = resultado || encontrarMatch(hr, idx);
    processados++;
    if (onProgress) {
      await onProgress({
        processados,
        total,
        pct: total ? Math.round((processados / total) * 1000) / 10 : 100
      });
    }

    if (tipo === 'ambiguo') {
      relatorio.ambiguo++;
      relatorio.items.push({
        funcionario_id: hr.id,
        nome: hr.nome,
        matricula: hr.matricula,
        acao: 'skip_ambiguo',
        status: 'skipped'
      });
      continue;
    }
    if (!match) {
      relatorio.sem_match++;
      continue;
    }

    const adm = statusAdmissao(hr.data_admissao, match.admissao);
    if (adm === 'divergente') {
      relatorio.skip_admissao++;
      relatorio.items.push({
        funcionario_id: hr.id,
        nome: hr.nome,
        matricula: hr.matricula,
        acao: 'skip_admissao_divergente',
        before_data: { data_admissao: hr.data_admissao },
        after_data: { admissao_giap: match.admissao },
        status: 'skipped'
      });
      if (jobId) {
        await sb().from('giap_job_items').insert({
          job_id: jobId,
          funcionario_id: hr.id,
          matricula: hr.matricula != null ? String(hr.matricula) : null,
          nome: hr.nome,
          acao: 'skip_admissao_divergente',
          before_data: { data_admissao: hr.data_admissao },
          after_data: { admissao_giap: match.admissao },
          status: 'skipped'
        });
      }
      continue;
    }

    relatorio.matched++;
    if (!TIPOS_ENRIQUECER.has(tipo)) continue;

    const patchFunc = {};
    const before = {
      nome: hr.nome,
      matricula: hr.matricula,
      data_admissao: hr.data_admissao
    };
    const acoes = [];

    // Matrícula vazia + match confiável (nome/matrícula) → preenche
    if (matriculaVazia(hr.matricula) && match.matricula) {
      patchFunc.matricula = String(match.matricula);
      acoes.push('matricula');
      relatorio.matricula_preenchida++;
    }

    // Admissão vazia no RH → preenche com GIAP
    if (adm === 'sem_rh' && match.admissao) {
      patchFunc.data_admissao = match.admissao;
      acoes.push('admissao');
      relatorio.admissao_preenchida++;
    }

    // Nome: só corrige quando a chave foi matrícula (GIAP é fonte do nome)
    if (
      tipo === 'matricula' &&
      match.funcionario &&
      normalizarNome(hr.nome) !== normalizarNome(match.funcionario)
    ) {
      patchFunc.nome = match.funcionario;
      acoes.push('nome');
      relatorio.nome_corrigido++;
    }

    // Vínculo SP: só quando admissão confere — NUNCA lotacao_id / unidade
    let vinculoPatch = null;
    if (adm === 'ok') {
      const lot = lotByFunc.get(hr.id);
      if (cargoEhServicoPrestado(match.cargo_origem) && vinculoSpId && lot) {
        const atual = vincById.get(lot.vinculo_id);
        const catAtual = String(atual?.categoria || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toUpperCase()
          .trim();
        if (catAtual !== 'SERVICO PRESTADO') {
          vinculoPatch = {
            funcionario_lotacao_id: lot.id,
            vinculo_id: vinculoSpId,
            de: atual?.categoria || null
          };
          acoes.push('vinculo_sp');
          relatorio.vinculo_sp_corrigido++;
        }
      }
    }

    if (!acoes.length) continue;

    const item = {
      funcionario_id: hr.id,
      nome: hr.nome,
      matricula: hr.matricula || match.matricula,
      acao: acoes.join('+'),
      before_data: before,
      after_data: { ...patchFunc, vinculo: vinculoPatch },
      status: dryRun ? 'pending' : 'applied'
    };

    if (!dryRun) {
      if (Object.keys(patchFunc).length) {
        const { error } = await sb().from('funcionarios').update(patchFunc).eq('id', hr.id);
        if (error) {
          item.status = 'error';
          item.erro = error.message;
        }
      }
      // Apenas vinculo_id — nunca lotacao_id / unidade operacional
      if (vinculoPatch && item.status !== 'error') {
        const { error } = await sb()
          .from('funcionario_lotacao')
          .update({ vinculo_id: vinculoPatch.vinculo_id })
          .eq('id', vinculoPatch.funcionario_lotacao_id);
        if (error) {
          item.status = 'error';
          item.erro = error.message;
        }
      }
    }

    relatorio.items.push(item);
    if (jobId) {
      await sb().from('giap_job_items').insert({
        job_id: jobId,
        funcionario_id: item.funcionario_id,
        matricula: item.matricula != null ? String(item.matricula) : null,
        nome: item.nome,
        acao: item.acao,
        before_data: item.before_data,
        after_data: item.after_data,
        status: item.status,
        erro: item.erro || null
      });
    }
  }

  return relatorio;
}

/**
 * Elegíveis (não terceirizados) ainda ausentes da folha da competência.
 * Sem matrícula: busca SÓ pelo nome completo (como no Portal Dados Abertos).
 */
export async function listarBuscasNomePendentes(competencia) {
  const folha = await carregarFolhaCompetencia(competencia);
  const nomesFolha = new Set(
    folha.map((f) => normalizarNome(f.funcionario)).filter(Boolean)
  );
  const matriculasFolha = new Set(
    folha.map((f) => String(f.matricula ?? '').trim()).filter(Boolean)
  );

  const idsElegiveis = await carregarIdsElegiveisFolhaPmsl();

  const funcs = await selectTudo(() =>
    sb()
      .from('funcionarios')
      .select('id, nome, matricula, data_admissao')
      .eq('ativo', true)
      .order('id')
  );

  const buscas = [];
  const vistosChave = new Set();
  for (const hr of funcs || []) {
    if (!idsElegiveis.has(hr.id)) continue; // terceirizado/sem lotação → fora

    const temMatricula = !matriculaVazia(hr.matricula);
    if (temMatricula && matriculasFolha.has(String(hr.matricula).trim())) continue;

    const nn = normalizarNome(hr.nome);
    if (!nn || nomesFolha.has(nn)) continue;
    if (tokensLen(hr.nome) < 2) continue;

    const variantes = estrategiasBuscaProgressiva(hr.nome);
    if (!variantes.length) continue;

    // Dedup por nome normalizado (não pela 1ª variante)
    if (vistosChave.has(nn)) continue;
    vistosChave.add(nn);

    buscas.push({
      funcionario_id: hr.id,
      nome: hr.nome,
      matricula: temMatricula ? String(hr.matricula).trim() : null,
      tem_matricula: temMatricula,
      busca: variantes[0],
      variantes,
      data_admissao: hr.data_admissao
    });
  }
  return buscas;
}

/** @deprecated use listarBuscasNomePendentes — mantido p/ scripts antigos. */
export async function listarBuscasNomeSemMatricula(competencia) {
  const todas = await listarBuscasNomePendentes(competencia);
  return todas.filter((b) => !b.tem_matricula);
}

/**
 * Exoneração automática (demissao) + fila de revisão (ausência).
 * Otimizado p/ Render 512MB: progresso throttled + inserts em lote.
 */
export async function aplicarExoneracoes({
  competencia,
  dryRun = false,
  onProgress = null,
  jobId = null,
  verificadosIds = null
} = {}) {
  const folha = await carregarFolhaSemcas(competencia);
  const porMatricula = new Map(folha.map((f) => [String(f.matricula), f]));
  // Ausência só conta para quem foi efetivamente pesquisado por nome nesta
  // execução (folha do GIAP carrega aos poucos — sem isso, falso positivo).
  const verificados = verificadosIds ? new Set(verificadosIds) : null;
  // Com a folha da competência ainda magra no GIAP (carga parcial), nem avalia
  // ausência — só demissão explícita. Ajuste via GIAP_MIN_FOLHA_AUSENCIA.
  const minFolhaAusencia = Math.max(0, Number(process.env.GIAP_MIN_FOLHA_AUSENCIA || 300));
  const ausenciaHabilitada = folha.length >= minFolhaAusencia;

  const funcs = await selectTudo(() =>
    sb()
      .from('funcionarios')
      .select('id, nome, matricula, ativo')
      .eq('ativo', true)
      .order('id')
  );

  const idsElegiveis = await carregarIdsElegiveisFolhaPmsl();
  const comMatricula = (funcs || []).filter(
    (f) => idsElegiveis.has(f.id) && !matriculaVazia(f.matricula)
  );

  const relatorio = {
    competencia,
    total_com_matricula: comMatricula.length,
    exonerados: 0,
    revisao_ausencia: 0,
    ausencia_nao_verificada: 0,
    ausencia_pausada_folha_magra: 0,
    folha_registros: folha.length,
    items: []
  };

  const total = comMatricula.length;
  let processados = 0;
  let lastPctReport = -1;
  const batchItems = [];
  const MAX_ITEMS_SAMPLE = 40; // não estoura memória / DB no dry-run

  async function flushItems() {
    if (!jobId || !batchItems.length) return;
    const chunk = batchItems.splice(0, batchItems.length);
    const { error: errIns } = await sb().from('giap_job_items').insert(chunk);
    if (errIns) console.warn('[exo] insert items', errIns.message);
  }

  for (const hr of comMatricula) {
    processados++;
    const pct = total ? Math.round((processados / total) * 1000) / 10 : 100;
    if (onProgress && (pct - lastPctReport >= 2 || processados === total)) {
      lastPctReport = pct;
      await onProgress({ processados, total, pct });
    }

    const mat = String(hr.matricula).trim();
    const naFolha = porMatricula.get(mat);

    if (naFolha?.demissao) {
      const item = {
        funcionario_id: hr.id,
        nome: hr.nome,
        matricula: mat,
        acao: 'exoneracao',
        before_data: { ativo: true },
        after_data: { data_exoneracao: naFolha.demissao, demissao_giap: naFolha.demissao },
        status: dryRun ? 'pending' : 'applied'
      };

      if (!dryRun) {
        const { error: errRpc } = await sb().rpc('fn_exonerar_funcionario', {
          p_funcionario_id: hr.id,
          p_data_exoneracao: naFolha.demissao,
          p_motivo: `GIAP demissão ${naFolha.demissao} (competência ${competencia})`
        });
        if (errRpc) {
          item.status = 'error';
          item.erro = errRpc.message;
        } else {
          relatorio.exonerados++;
          await sb()
            .from('giap_revisao_ausencia')
            .update({ status: 'exonerado', resolved_at: new Date().toISOString() })
            .eq('funcionario_id', hr.id)
            .eq('status', 'pendente');
        }
      } else {
        relatorio.exonerados++;
      }

      if (relatorio.items.length < MAX_ITEMS_SAMPLE) relatorio.items.push(item);
      if (jobId) {
        batchItems.push({
          job_id: jobId,
          funcionario_id: item.funcionario_id,
          matricula: item.matricula,
          nome: item.nome,
          acao: item.acao,
          before_data: item.before_data,
          after_data: item.after_data,
          status: item.status,
          erro: item.erro || null
        });
      }
      if (batchItems.length >= 50) await flushItems();
      continue;
    }

    // Ausente da folha SEMCAS desta competência, sem demissão → revisão
    if (!naFolha) {
      if (!ausenciaHabilitada) {
        relatorio.ausencia_pausada_folha_magra++;
        continue;
      }
      if (verificados && !verificados.has(hr.id)) {
        // Ainda não pesquisado por nome nesta execução — não dá pra afirmar ausência
        relatorio.ausencia_nao_verificada++;
        continue;
      }
      relatorio.revisao_ausencia++;
      const item = {
        funcionario_id: hr.id,
        nome: hr.nome,
        matricula: mat,
        acao: 'revisao_ausencia',
        before_data: { ativo: true },
        after_data: { competencia, motivo: 'ausente_folha_sem_demissao' },
        status: 'revisao'
      };
      if (relatorio.items.length < MAX_ITEMS_SAMPLE) relatorio.items.push(item);

      if (!dryRun) {
        await sb().from('giap_revisao_ausencia').upsert(
          {
            funcionario_id: hr.id,
            competencia,
            matricula: mat,
            nome: hr.nome,
            status: 'pendente',
            job_id: jobId
          },
          { onConflict: 'funcionario_id,competencia' }
        );
      }

      // Dry-run: só amostra no log (centenas de inserts matavam o Render)
      if (jobId && (!dryRun || relatorio.revisao_ausencia <= MAX_ITEMS_SAMPLE)) {
        batchItems.push({
          job_id: jobId,
          funcionario_id: item.funcionario_id,
          matricula: item.matricula,
          nome: item.nome,
          acao: item.acao,
          before_data: item.before_data,
          after_data: item.after_data,
          status: item.status
        });
      }
      if (batchItems.length >= 50) await flushItems();
    }
  }

  await flushItems();
  return relatorio;
}

/**
 * Demissões p/ Comissionados e Contratos (exclui Efetivo, Serviço Prestado e terceirizados).
 *
 * 1) Cruza folha_pmsl já gravada (competências recentes) em busca de demissão.
 * 2) Quem NÃO tiver demissão no banco → consulta a API mês a mês (atual → mais antigo)
 *    até achar demissão ou esgotar os meses — sem teto artificial de 8 scrapes.
 */
export async function buscarDemissoesVinculos({
  competencia,
  dryRun = true,
  jobId = null,
  mesesAtras = 12,
  onProgress = null,
  /** Se true (padrão), só insiste na API em quem NÃO está na folha da competência atual. */
  soForaDaFolhaAtual = true
} = {}) {
  const { syncPorNome } = await import('./sync.js');
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  const VINCULOS_DEM = new Set(
    ['COMISSIONADO', 'CONTRATO SEMUS', 'CONTRATO TEMPORARIO'].map(normalizarCategoria)
  );

  const lots = await selectTudo(() =>
    sb()
      .from('funcionario_lotacao')
      .select('id, funcionario_id, vinculo_id, ativo, data_fim')
      .eq('ativo', true)
      .order('id')
  );
  const { data: vinculos, error: errV } = await sb().from('vinculos').select('id, categoria');
  if (errV) throw errV;
  const catById = new Map(
    (vinculos || []).map((v) => [v.id, normalizarCategoria(v.categoria)])
  );

  const idsAlvo = new Set();
  for (const l of lots || []) {
    if (l.data_fim) continue;
    const cat = catById.get(l.vinculo_id);
    if (cat && VINCULOS_DEM.has(cat)) idsAlvo.add(l.funcionario_id);
  }

  const funcs = await selectTudo(() =>
    sb()
      .from('funcionarios')
      .select('id, nome, matricula, data_admissao, ativo')
      .eq('ativo', true)
      .order('id')
  );
  const alvos = (funcs || []).filter((f) => idsAlvo.has(f.id));

  // Competências: atual → mais antigas
  const comps = [];
  let c = Number(competencia);
  for (let i = 0; i < Math.max(1, mesesAtras); i++) {
    comps.push(c);
    let y = Math.floor(c / 100);
    let m = c % 100;
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    c = y * 100 + m;
  }

  // Folha da competência atual (pra saber quem "não foi encontrado")
  const matsFolhaAtual = new Set();
  const nomesFolhaAtual = new Set();
  {
    const folhaAtual = await selectTudo(() =>
      sb()
        .from('folha_pmsl')
        .select('matricula, funcionario, funcionario_norm')
        .eq('competencia', Number(competencia))
        .order('id')
    );
    for (const row of folhaAtual || []) {
      if (row.matricula) matsFolhaAtual.add(String(row.matricula).trim());
      const nn = row.funcionario_norm || normalizarNome(row.funcionario);
      if (nn) nomesFolhaAtual.add(nn);
    }
  }

  const estaNaFolhaAtual = (hr) => {
    if (!matriculaVazia(hr.matricula) && matsFolhaAtual.has(String(hr.matricula).trim())) return true;
    const nn = normalizarNome(hr.nome);
    return !!(nn && nomesFolhaAtual.has(nn));
  };

  // Demissões / aparições já gravadas no banco (qualquer das comps)
  const { data: folhaDem, error: errF } = await sb()
    .from('folha_pmsl')
    .select('matricula, funcionario, funcionario_norm, admissao, demissao, competencia, lotacao, codigo_orgao')
    .in('competencia', comps)
    .not('demissao', 'is', null);
  if (errF) throw errF;

  // Também carrega aparições SEM exigir demissão (pra não scrapar à toa)
  const folhaTudo = await selectTudo(() =>
    sb()
      .from('folha_pmsl')
      .select('matricula, funcionario, funcionario_norm, admissao, demissao, competencia')
      .in('competencia', comps)
      .order('competencia', { ascending: false })
  );

  const porMatDem = new Map();
  const porNomeDem = new Map();
  for (const row of folhaDem || []) {
    if (row.matricula) {
      const prev = porMatDem.get(String(row.matricula).trim());
      if (!prev || Number(row.competencia) > Number(prev.competencia)) {
        porMatDem.set(String(row.matricula).trim(), row);
      }
    }
    const nn = row.funcionario_norm || normalizarNome(row.funcionario);
    if (nn) {
      const prev = porNomeDem.get(nn);
      if (!prev || Number(row.competencia) > Number(prev.competencia)) {
        porNomeDem.set(nn, row);
      }
    }
  }

  const porMatUltima = new Map();
  const porNomeUltima = new Map();
  for (const row of folhaTudo || []) {
    if (row.matricula) {
      const k = String(row.matricula).trim();
      if (!porMatUltima.has(k)) porMatUltima.set(k, row); // já vem desc por competência
    }
    const nn = row.funcionario_norm || normalizarNome(row.funcionario);
    if (nn && !porNomeUltima.has(nn)) porNomeUltima.set(nn, row);
  }

  const acharDemLocal = (hr) => {
    if (!matriculaVazia(hr.matricula)) {
      const h = porMatDem.get(String(hr.matricula).trim());
      if (h) return h;
    }
    return porNomeDem.get(normalizarNome(hr.nome)) || null;
  };

  /** Última aparição em qualquer competência (com ou sem demissão). */
  const acharUltimaLocal = (hr) => {
    if (!matriculaVazia(hr.matricula)) {
      const h = porMatUltima.get(String(hr.matricula).trim());
      if (h) return h;
    }
    return porNomeUltima.get(normalizarNome(hr.nome)) || null;
  };

  /** Relê demissão no banco após scrape (por matrícula ou nome). */
  const lerDemissaoAposScrape = async (hr, compScrape) => {
    if (!matriculaVazia(hr.matricula)) {
      const { data: byMat } = await sb()
        .from('folha_pmsl')
        .select('matricula, funcionario, admissao, demissao, competencia')
        .eq('matricula', String(hr.matricula).trim())
        .not('demissao', 'is', null)
        .in('competencia', comps)
        .order('competencia', { ascending: false })
        .limit(1);
      if (byMat?.[0]) return byMat[0];
    }
    const nn = normalizarNome(hr.nome);
    if (nn) {
      const { data: byNome } = await sb()
        .from('folha_pmsl')
        .select('matricula, funcionario, admissao, demissao, competencia')
        .eq('funcionario_norm', nn)
        .not('demissao', 'is', null)
        .in('competencia', comps)
        .order('competencia', { ascending: false })
        .limit(1);
      if (byNome?.[0]) return byNome[0];
    }
    // Também tenta a competência recém-puxada (demissão pode ter vindo nela)
    const { data: naComp } = await sb()
      .from('folha_pmsl')
      .select('matricula, funcionario, admissao, demissao, competencia, funcionario_norm')
      .eq('competencia', Number(compScrape))
      .limit(2000);
    const mat = !matriculaVazia(hr.matricula) ? String(hr.matricula).trim() : '';
    const hit = (naComp || []).find((r) => {
      if (mat && String(r.matricula || '').trim() === mat) return true;
      return (r.funcionario_norm || normalizarNome(r.funcionario)) === nn;
    });
    return hit || null;
  };

  const relatorio = {
    competencia,
    total_alvos: alvos.length,
    fora_folha_atual: 0,
    com_demissao: 0,
    sem_demissao: 0,
    confirmados_api: 0,
    scrapes: 0,
    comps,
    items: []
  };

  // GIAP_MAX_BUSCAS_NOME no Render free costuma ser 3 — NÃO usar aqui.
  // Este job precisa confirmar demissão de todos os "fora da folha".
  const MAX_SCRAPE = Math.max(
    0,
    Number(
      process.env.GIAP_MAX_BUSCAS_DEMISSAO != null && process.env.GIAP_MAX_BUSCAS_DEMISSAO !== ''
        ? process.env.GIAP_MAX_BUSCAS_DEMISSAO
        : 20000
    )
  );
  let scrapesFeitos = 0;
  let alvosApi = 0;
  let atingiuLimite = false;

  for (let i = 0; i < alvos.length; i++) {
    const hr = alvos[i];
    const foraAtual = !estaNaFolhaAtual(hr);
    if (foraAtual) relatorio.fora_folha_atual++;

    if (onProgress) {
      await onProgress({
        processados: i + 1,
        total: alvos.length,
        pct: alvos.length ? Math.round(((i + 1) / alvos.length) * 100) : 100,
        scrapes: scrapesFeitos,
        etapa: foraAtual ? 'fora_folha' : 'na_folha'
      });
    }

    let hit = acharDemLocal(hr);
    const ultimaLocal = hit || acharUltimaLocal(hr);
    if (!hit && ultimaLocal?.demissao) hit = ultimaLocal;

    // API só se: sem demissão no banco E sem nenhuma aparição local nas comps
    // (se já apareceu sem demissão, não precisa scrapar de novo)
    const precisaApi =
      !hit &&
      !ultimaLocal &&
      (soForaDaFolhaAtual ? foraAtual : true);

    if (precisaApi && hr.nome) {
      alvosApi++;
      if (scrapesFeitos >= MAX_SCRAPE) {
        atingiuLimite = true;
      } else {
        const busca = nomeBuscaGiap(hr.nome);
        if (busca) {
          for (const compScrape of comps) {
            if (scrapesFeitos >= MAX_SCRAPE) {
              atingiuLimite = true;
              break;
            }
            try {
              scrapesFeitos++;
              relatorio.scrapes++;
              if (onProgress) {
                await onProgress({
                  processados: i + 1,
                  total: alvos.length,
                  pct: alvos.length ? Math.round(((i + 1) / alvos.length) * 100) : 100,
                  scrapes: scrapesFeitos,
                  etapa: `api_${compScrape}`,
                  nome: hr.nome
                });
              }
              await syncPorNome({
                nomeServidor: busca,
                codigoInstituicao: 1,
                competencia: compScrape,
                filtrarNomeAlvo: hr.nome,
                maxVariantes: 1
              });
              const apos = await lerDemissaoAposScrape(hr, compScrape);
              if (apos?.demissao) {
                hit = apos;
                relatorio.confirmados_api++;
                break;
              }
              // Sem demissão neste mês → tenta o mais antigo automaticamente
            } catch (err) {
              console.warn('[demissoes] scrape', hr.nome, compScrape, err.message);
              await pause(2000);
            }
            await pause(800);
          }
        }
      }
    }

    if (hit?.demissao) {
      relatorio.com_demissao++;
      const item = {
        funcionario_id: hr.id,
        nome: hr.nome,
        matricula: hr.matricula,
        demissao: hit.demissao,
        competencia_folha: hit.competencia,
        acao: 'demissao_encontrada',
        status: 'pending',
        fora_folha_atual: foraAtual
      };
      if (relatorio.items.length < 200) relatorio.items.push(item);

      if (jobId) {
        await sb().from('giap_job_items').insert({
          job_id: jobId,
          funcionario_id: hr.id,
          matricula: hr.matricula != null ? String(hr.matricula) : null,
          nome: hr.nome,
          acao: 'demissao_encontrada',
          before_data: { ativo: true, fora_folha_atual: foraAtual },
          after_data: { demissao: hit.demissao, competencia: hit.competencia },
          status: 'pending',
          erro: null
        });
      }
    } else {
      relatorio.sem_demissao++;
      if (precisaApi && foraAtual && relatorio.items.length < 200) {
        relatorio.items.push({
          funcionario_id: hr.id,
          nome: hr.nome,
          matricula: hr.matricula,
          demissao: null,
          competencia_folha: null,
          acao: 'sem_demissao_apos_busca',
          status: atingiuLimite && scrapesFeitos >= MAX_SCRAPE ? 'limitado' : 'pending',
          fora_folha_atual: true
        });
      }
    }
  }

  relatorio.alvos_api = alvosApi;
  relatorio.max_scrape = MAX_SCRAPE;
  relatorio.atingiu_limite_scrape = atingiuLimite;

  return relatorio;
}

/**
 * Auditoria de saídas: dado um intervalo [compPiso, compRef], responde por
 * cada RH ativo qual a última competência em que apareceu no GIAP e se veio
 * com demissao. Estratégia:
 *   1) Quem está na folha de compRef → status "ativo_compref", zero scrape.
 *   2) Faltantes → syncPorNome mês a mês (compRef-1 → compPiso), para na
 *      primeira aparição (com/sem demissao). Se apareceu com demissao →
 *      "candidato_exo"; sem demissao → "sumiu"; nunca apareceu → "sem_historico".
 *   3) Suporta continuação via pendentesIds (checkpoint em giap_jobs.resumo).
 *   4) onResultado(veredito) é chamado após cada pessoa — o job persiste em
 *      giap_auditoria_saidas.
 */
export async function auditarSaidas({
  compRef,
  compPiso,
  escopo = 'todos_ativos',
  pendentesIds = null,
  loteMax = 25,
  onResultado = null,
  onProgress = null,
  jobId = null
} = {}) {
  const { syncPorNome } = await import('./sync.js');
  const { closeBrowser } = await import('./scraper.js');
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  // Envelope de segurança: se o Puppeteer congelar, força saída, fecha Chrome
  // e o loop segue pro próximo mês/pessoa.
  const scrapeWatchdogMs = Math.max(60000, Number(process.env.GIAP_SCRAPE_WATCHDOG_MS || 180000));
  const scrapeComTimeout = (promise, label) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`watchdog: ${label} não respondeu em ${Math.round(scrapeWatchdogMs / 1000)}s`)),
          scrapeWatchdogMs
        );
      })
    ]).finally(() => clearTimeout(timer));
  };

  const refN = Number(compRef);
  const pisoN = Number(compPiso);
  if (!refN || !pisoN || pisoN > refN) {
    throw new Error(`Intervalo inválido: compRef=${compRef}, compPiso=${compPiso}`);
  }

  const comps = [];
  {
    let c = refN;
    while (c >= pisoN) {
      comps.push(c);
      let y = Math.floor(c / 100);
      let m = c % 100;
      m -= 1;
      if (m < 1) { m = 12; y -= 1; }
      c = y * 100 + m;
    }
  }
  const compsAnteriores = comps.slice(1); // compRef-1 → compPiso (o mais novo primeiro)

  // ————————————————— alvos —————————————————
  let alvos = [];
  const preselecionados = pendentesIds && pendentesIds.length;

  if (preselecionados) {
    const idsWanted = new Set(pendentesIds.map(Number));
    const funcs = await selectTudo(() =>
      sb()
        .from('funcionarios')
        .select('id, nome, matricula, ativo')
        .in('id', [...idsWanted])
        .order('id')
    );
    alvos = (funcs || []).filter((f) => f.ativo !== false);
  } else {
    const idsElegiveis = await carregarIdsElegiveisFolhaPmsl();
    const funcs = await selectTudo(() =>
      sb()
        .from('funcionarios')
        .select('id, nome, matricula, ativo')
        .eq('ativo', true)
        .order('id')
    );
    alvos = (funcs || []).filter((f) => idsElegiveis.has(f.id) && tokensLen(f.nome) >= 2);
  }

  // ———— índice da folha do range (o que já está gravado) ————
  const folhaRange = await selectTudo(() =>
    sb()
      .from('folha_pmsl')
      .select('matricula, funcionario, funcionario_norm, demissao, competencia')
      .in('competencia', comps)
      .order('competencia', { ascending: false })
  );

  const idxCompRefMat = new Set();
  const idxCompRefNome = new Set();
  const porMat = new Map();  // matKey → { competencia,demissao,funcionario } (mais recente vence)
  const porNome = new Map(); // nomeNorm → idem
  for (const f of folhaRange || []) {
    const compF = Number(f.competencia);
    const mk = f.matricula != null ? String(f.matricula).trim() : '';
    const nn = f.funcionario_norm || normalizarNome(f.funcionario);
    const row = {
      competencia: compF,
      demissao: f.demissao || null,
      funcionario: f.funcionario,
      matricula: f.matricula
    };
    if (compF === refN) {
      if (mk) idxCompRefMat.add(mk);
      if (nn) idxCompRefNome.add(nn);
    }
    if (mk) {
      const prev = porMat.get(mk);
      if (!prev || compF > prev.competencia || (row.demissao && !prev.demissao)) {
        porMat.set(mk, row);
      }
    }
    if (nn) {
      const prev = porNome.get(nn);
      if (!prev || compF > prev.competencia || (row.demissao && !prev.demissao)) {
        porNome.set(nn, row);
      }
    }
  }

  const naFolhaCompRef = (hr) => {
    const mk = !matriculaVazia(hr.matricula) ? String(hr.matricula).trim() : '';
    if (mk && idxCompRefMat.has(mk)) return true;
    const nn = normalizarNome(hr.nome);
    return !!(nn && idxCompRefNome.has(nn));
  };

  const acharLocalPorHR = (hr, compFiltro = null) => {
    const mk = !matriculaVazia(hr.matricula) ? String(hr.matricula).trim() : '';
    if (mk) {
      const h = porMat.get(mk);
      if (h && (!compFiltro || h.competencia === compFiltro)) return h;
    }
    const nn = normalizarNome(hr.nome);
    if (nn) {
      const h = porNome.get(nn);
      if (h && (!compFiltro || h.competencia === compFiltro)) return h;
    }
    return null;
  };

  const lerAposScrape = async (hr, compScrape) => {
    const mk = !matriculaVazia(hr.matricula) ? String(hr.matricula).trim() : '';
    if (mk) {
      const { data } = await sb()
        .from('folha_pmsl')
        .select('matricula, funcionario, admissao, demissao, competencia, funcionario_norm')
        .eq('matricula', mk)
        .eq('competencia', Number(compScrape))
        .limit(1);
      if (data?.[0]) return data[0];
    }
    const nn = normalizarNome(hr.nome);
    if (nn) {
      const { data } = await sb()
        .from('folha_pmsl')
        .select('matricula, funcionario, admissao, demissao, competencia, funcionario_norm')
        .eq('funcionario_norm', nn)
        .eq('competencia', Number(compScrape))
        .limit(1);
      if (data?.[0]) return data[0];
    }
    return null;
  };

  // ————————————— itera —————————————
  const stats = {
    total: alvos.length,
    processados: 0,
    ativo_compref: 0,
    candidato_exo: 0,
    sumiu: 0,
    sem_historico: 0,
    scrapes: 0
  };
  const pendentesRestantes = [];

  const emitir = async (hr, veredito) => {
    stats.processados++;
    stats[veredito.status] = (stats[veredito.status] || 0) + 1;
    if (onResultado) {
      try {
        await onResultado({
          funcionario_id: hr.id,
          matricula: hr.matricula != null ? String(hr.matricula) : null,
          nome: hr.nome,
          ...veredito
        });
      } catch (e) {
        console.warn('[aud] onResultado', hr.nome, e.message);
      }
    }
    if (onProgress) {
      try {
        await onProgress({
          processados: stats.processados,
          total: stats.total,
          pct: stats.total ? Math.round((stats.processados / stats.total) * 100) : 100,
          scrapes: stats.scrapes,
          etapa: veredito.status,
          nome: hr.nome
        });
      } catch (_) { /* ok */ }
    }
  };

  // Escopo === 'nao_identificados': só olha quem não está na folha de compRef.
  // (escopo === 'todos_ativos' inclui os presentes como "ativo_compref" e sai.)
  const emitirAtivoCompRef = escopo !== 'nao_identificados';

  const parseWatchdog = Math.max(60000, Number(process.env.GIAP_SCRAPE_WATCHDOG_MS || 180000));

  let scrapesNesteLote = 0;
  for (let i = 0; i < alvos.length; i++) {
    const hr = alvos[i];

    // 1) Presente em compRef → ativo, sem scrape
    if (naFolhaCompRef(hr)) {
      if (emitirAtivoCompRef) {
        await emitir(hr, {
          status: 'ativo_compref',
          competencia: refN,
          demissao: null,
          fonte: 'folha_compref'
        });
      } else {
        stats.processados++;
      }
      continue;
    }

    // 2) Já tem aparição local em qualquer mês do range?
    const localHit = acharLocalPorHR(hr);
    if (localHit) {
      await emitir(hr, {
        status: localHit.demissao ? 'candidato_exo' : 'sumiu',
        competencia: localHit.competencia,
        demissao: localHit.demissao || null,
        fonte: 'banco'
      });
      continue;
    }

    // 3) Faltante — scrape mês a mês (compRef-1 → compPiso)
    if (tokensLen(hr.nome) < 2) {
      await emitir(hr, {
        status: 'sem_historico',
        competencia: null,
        demissao: null,
        fonte: 'nome_curto'
      });
      continue;
    }

    // Corta o lote se já bateu limite (checkpoint)
    if (loteMax > 0 && scrapesNesteLote >= loteMax) {
      pendentesRestantes.push(...alvos.slice(i).map((a) => a.id));
      break;
    }

    const busca = nomeBuscaGiap(hr.nome);
    let acharado = null;
    let watchdogsSeguidos = 0;
    if (busca) {
      for (const compScrape of compsAnteriores) {
        try {
          scrapesNesteLote++;
          stats.scrapes++;
          if (onProgress) {
            try {
              await onProgress({
                processados: stats.processados,
                total: stats.total,
                pct: stats.total ? Math.round((stats.processados / stats.total) * 100) : 100,
                scrapes: stats.scrapes,
                etapa: `scrape_${compScrape}`,
                nome: hr.nome
              });
            } catch (_) { /* ok */ }
          }
          await scrapeComTimeout(
            syncPorNome({
              nomeServidor: busca,
              codigoInstituicao: 1,
              competencia: compScrape,
              filtrarNomeAlvo: hr.nome,
              apenasSemcas: false, // exonerado pode ter migrado antes; queremos qualquer aparição
              maxVariantes: 1
            }),
            `sync_nome_${busca}@${compScrape}`
          );
          const apos = await lerAposScrape(hr, compScrape);
          watchdogsSeguidos = 0;
          if (apos) {
            acharado = { ...apos, competencia: Number(apos.competencia) };
            break;
          }
        } catch (err) {
          console.warn('[aud] scrape', hr.nome, compScrape, err.message);
          // Watchdog / erro de frame → derruba o Chromium; a próxima iteração recria.
          if (/watchdog|main frame|Target closed|detached Frame|Session closed|Protocol error|Execution context/i.test(err.message || '')) {
            await closeBrowser().catch(() => {});
            watchdogsSeguidos++;
            // Portal instável demais para esta pessoa — desiste e passa pra próxima.
            if (watchdogsSeguidos >= 3) {
              console.warn('[aud] 3 watchdogs seguidos em', hr.nome, '→ pula pessoa');
              break;
            }
          }
          await pause(1500);
        }
        await pause(500);
      }
    }

    if (acharado) {
      await emitir(hr, {
        status: acharado.demissao ? 'candidato_exo' : 'sumiu',
        competencia: acharado.competencia,
        demissao: acharado.demissao || null,
        fonte: 'folha+api'
      });
    } else {
      await emitir(hr, {
        status: 'sem_historico',
        competencia: null,
        demissao: null,
        fonte: 'sem_hit'
      });
    }
  }

  return {
    comps,
    stats,
    pendentesIds: pendentesRestantes,
    concluido: pendentesRestantes.length === 0
  };
}

export { CODIGO_ORGAO_SEMCAS, getSupabase };
