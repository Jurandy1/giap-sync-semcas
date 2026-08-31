/**
 * Memória de competências anteriores — âncora para localizar servidor no GIAP
 * sem redescobrir identidade a cada mês.
 */
import { getSupabase } from './supabase.js';
import { normalizarNome, normalizarCPF } from './utils.js';
import { matKey, tokensSignificativos, estrategiasBuscaProgressiva, maxVariantesNome } from './matching.js';

function sb() {
  return getSupabase();
}

async function selectTudo(build) {
  const PAGE = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/**
 * Carrega índice de histórico (competências < atual).
 * Chaves: matricula, cpf, funcionario_id (via remunerações).
 */
export async function carregarIndiceHistorico(competenciaAtual) {
  const folhaHist = await selectTudo(() =>
    sb()
      .from('folha_pmsl')
      .select('competencia, matricula, cpf, funcionario, codigo_orgao, lotacao, admissao')
      .lt('competencia', competenciaAtual)
      .order('competencia', { ascending: false })
  );

  const porMat = new Map();
  const porCpf = new Map();

  for (const r of folhaHist) {
    const mk = matKey(r.matricula);
    if (mk && mk !== '0' && !porMat.has(mk)) {
      porMat.set(mk, { ...r, _fonte: 'folha_pmsl' });
    }
    const cpf = normalizarCPF(r.cpf);
    if (cpf && !porCpf.has(cpf)) {
      porCpf.set(cpf, { ...r, _fonte: 'folha_pmsl' });
    }
  }

  let remCount = 0;
  const porFuncRem = new Map();
  try {
    const rems = await selectTudo(() =>
      sb()
        .from('funcionario_remuneracoes')
        .select('funcionario_id, competencia, matricula, cpf, lotacao_giap, codigo_orgao')
        .order('competencia', { ascending: false })
    );
    remCount = rems.length;
    for (const r of rems) {
      if (r.funcionario_id && !porFuncRem.has(r.funcionario_id)) {
        porFuncRem.set(r.funcionario_id, {
          competencia: r.competencia,
          matricula: r.matricula,
          cpf: r.cpf,
          funcionario: null,
          codigo_orgao: r.codigo_orgao,
          lotacao: r.lotacao_giap,
          _fonte: 'funcionario_remuneracoes'
        });
      }
      const mk = matKey(r.matricula);
      if (mk && mk !== '0' && !porMat.has(mk)) {
        porMat.set(mk, {
          competencia: r.competencia,
          matricula: r.matricula,
          cpf: r.cpf,
          funcionario: null,
          codigo_orgao: r.codigo_orgao,
          lotacao: r.lotacao_giap,
          _fonte: 'funcionario_remuneracoes'
        });
      }
    }
  } catch (e) {
    console.warn('[historico] remuneracoes:', e.message);
  }

  return {
    porMat,
    porCpf,
    porFuncRem,
    total_folha: folhaHist.length,
    total_remuneracoes: remCount
  };
}

/** Busca âncora histórica mais recente para um pendente. */
export function buscarHistoricoServidor(pendente, indice) {
  if (!pendente || !indice) return null;

  let hit = null;
  if (pendente.matricula) {
    hit = indice.porMat.get(matKey(pendente.matricula));
    if (hit) return { ...hit, _ligacao: 'matricula_rh' };
  }
  if (pendente.cpf) {
    hit = indice.porCpf.get(pendente.cpf);
    if (hit) return { ...hit, _ligacao: 'cpf_rh' };
  }
  hit = indice.porFuncRem.get(pendente.funcionario_id);
  if (hit) return { ...hit, _ligacao: 'funcionario_id_rem' };

  return null;
}

/** Histórico é confiável quando tem matrícula (e idealmente nome ou CPF). */
export function historicoEhConfiavel(hist) {
  if (!hist?.matricula) return false;
  const mk = matKey(hist.matricula);
  if (!mk || mk === '0') return false;
  return !!(hist.funcionario || normalizarCPF(hist.cpf));
}

/**
 * Classifica pendente: A=histórico confiável, B=matrícula RH, D=cedido, C=só nome, E=sem histórico.
 * Ordem de processamento: A → B → D → C → E
 */
export function classificarGrupoHistorico(pendente, historico, cedencias = { ids: new Set(), mats: new Set() }) {
  const ehCedido =
    cedencias.ids.has(pendente.funcionario_id) ||
    (pendente.matricula && cedencias.mats.has(matKey(pendente.matricula)));

  if (historico && historicoEhConfiavel(historico)) {
    return { grupo: 'A', historico, eh_cedido: ehCedido };
  }
  if (pendente.tem_matricula && pendente.matricula) {
    return { grupo: ehCedido ? 'D' : 'B', historico, eh_cedido: ehCedido };
  }
  if (ehCedido) return { grupo: 'D', historico, eh_cedido: true };
  if (tokensSignificativos(pendente.nome).length >= 2) {
    return { grupo: historico ? 'C' : 'E', historico, eh_cedido: false };
  }
  return { grupo: 'E', historico, eh_cedido: false };
}

/** Estratégias de busca GIAP — histórico primeiro, variantes só como fallback. */
export function estrategiasComHistorico(pendente, historico) {
  const out = [];
  const add = (s) => {
    const v = String(s || '').trim().toUpperCase();
    if (v.length >= 3 && !out.includes(v)) out.push(v);
  };

  if (historico?.funcionario) {
    const sig = tokensSignificativos(historico.funcionario);
    if (sig[0]) add(sig[0]);
    if (sig.length >= 2) add([sig[0], sig[1]].join(' '));
    if (sig.length >= 3) add(sig.slice(0, 3).join(' '));
  }

  if (historicoEhConfiavel(historico)) {
    return out.slice(0, 2);
  }

  // Sem histórico confiável: busca progressiva completa (até GIAP_MAX_VARIANTES_NOME)
  for (const e of estrategiasBuscaProgressiva(pendente.nome, maxVariantesNome())) {
    add(e);
  }
  return out.slice(0, maxVariantesNome());
}

/** Métricas de cobertura histórica para todos os pendentes. */
export function medirCoberturaHistorico(pendentes, indice, cedencias) {
  const stats = {
    pendentes_total: pendentes.length,
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
    grupo_E: 0
  };

  const enriquecidos = [];
  for (const p of pendentes) {
    const historico = buscarHistoricoServidor(p, indice);
    const cls = classificarGrupoHistorico(p, historico, cedencias);
    const item = { ...p, historico, grupo_historico: cls.grupo, eh_cedido: cls.eh_cedido };

    if (historico) {
      stats.historico_encontrado++;
      if (historico.matricula) stats.historico_com_matricula++;
      if (normalizarCPF(historico.cpf)) stats.historico_com_cpf++;
      if (historico.funcionario) stats.historico_com_nome++;
      else stats.historico_sem_matricula++;
    } else {
      stats.sem_historico++;
    }

    stats[`grupo_${cls.grupo}`]++;
    enriquecidos.push(item);
  }

  enriquecidos.sort((a, b) => {
    const ord = { A: 0, B: 1, D: 2, C: 3, E: 4 };
    return (ord[a.grupo_historico] ?? 9) - (ord[b.grupo_historico] ?? 9);
  });

  return { stats, pendentes: enriquecidos };
}

/**
 * SQL recomendado (rodar no Supabase) para auditoria:
 *
 * WITH folha_ult AS (
 *   SELECT DISTINCT ON (matricula)
 *     matricula, cpf, funcionario, competencia, codigo_orgao, lotacao
 *   FROM folha_pmsl
 *   WHERE competencia < :comp_atual AND matricula IS NOT NULL
 *   ORDER BY matricula, competencia DESC
 * )
 * SELECT f.id, f.nome, f.matricula, fu.*
 * FROM funcionarios f
 * JOIN folha_ult fu ON fu.matricula = f.matricula::text
 * WHERE f.ativo = true;
 */
