/**
 * Análise pós-teste: auditoria de tentativas, pendentes e cedidos.
 */
import { mascararCpf } from './rhsemcas.js';
import { calcularCoberturaPrefixos, tokensSignificativos } from './matching.js';
import { estrategiaHistoricoPrincipal } from './historico.js';

export function origemMatchPrincipal({ avaliacao, via, estrategia, viaBulkPrefixo = false }) {
  const fatores = avaliacao?.fatores || [];
  if (fatores.some((f) => /^cpf/.test(f) || f === 'cpf_ok')) return 'cpf';
  if (fatores.some((f) => /matricula_ok/.test(f) && !/historico/.test(f))) return 'matricula';
  if (via === 'historico' || fatores.some((f) => /historico/.test(f))) return 'historico';
  if (viaBulkPrefixo || estrategia?.startsWith?.('prefixo')) return 'prefixo';
  if (via === 'bulk_local' || via === 'indice_local') return 'bulk';
  if (via === 'nome') return 'nome';
  return via || 'outro';
}

export function classificarMotivoPendente(pendente, ctx = {}) {
  if (pendente.eh_cedido || pendente.grupo_historico === 'D') {
    const orgHist = pendente.historico?.codigo_orgao;
    if (orgHist && String(orgHist) !== '9') return 'recebido_cedido_outro_orgao';
    return 'recebido_cedido_sem_resultado';
  }
  if (!pendente.historico && pendente.grupo_historico === 'E') return 'sem_historico';
  if (pendente.matricula && String(pendente.matricula).length <= 5) return 'matricula_legada';
  if (ctx.tentativas?.some((t) => t.bruto > 0 && !t.match)) return 'homonimo_ou_nome_divergente';
  if (ctx.tentativas?.every((t) => t.bruto === 0)) return 'sem_resultado_giap';
  if (ctx.tentativas?.some((t) => t.outro_orgao)) return 'resultado_outro_orgao';
  if (pendente.grupo_historico === 'B') return 'nome_ou_matricula_divergente';
  return 'outro';
}

export function montarAuditoriaCandidatos(candidatos, auditPorId, detalhes, pendentesPosIds) {
  return candidatos.map((c) => {
    const audit = auditPorId.get(c.funcionario_id) || { tentativas: [] };
    const det = detalhes.find((d) => d.funcionario_id === c.funcionario_id);
    const resolvido = !pendentesPosIds.has(c.funcionario_id);
    const nomeHist = c.historico?.funcionario || null;
    const prefixos = [];
    const sig = tokensSignificativos(c.nome);
    if (sig[0]) prefixos.push(sig[0]);
    if (sig.length >= 2) prefixos.push([sig[0], sig[1]].join(' '));
    if (sig.length >= 3) prefixos.push(sig.slice(0, 3).join(' '));
    const estrategiaHist = estrategiaHistoricoPrincipal(c.historico);

    return {
      funcionario_id: c.funcionario_id,
      nome: c.nome,
      grupo: c.grupo_historico,
      eh_cedido: !!c.eh_cedido,
      possui_historico: !!c.historico,
      possui_matricula: !!c.matricula,
      possui_cpf: !!c.cpf,
      cpf_mascarado: mascararCpf(c.cpf),
      nome_historico: nomeHist,
      estrategia_historico_principal: estrategiaHist,
      prefixos_gerados: prefixos,
      tentativas: audit.tentativas,
      total_tentativas: audit.tentativas.length,
      consultas_giap: audit.tentativas.filter((t) => t.scrape).length,
      tentativa_que_resolveu: audit.tentativa_resolveu || null,
      resolvido,
      status: resolvido ? det?.status || 'resolvido' : 'pendente',
      origem_match: det?.origem_match || null,
      motivo_pendente: resolvido ? null : classificarMotivoPendente(c, audit)
    };
  });
}

export function analisarCedidos(candidatos, auditPorId) {
  const cedidos = candidatos.filter((c) => c.eh_cedido);
  return cedidos.map((c) => {
    const audit = auditPorId.get(c.funcionario_id) || { tentativas: [] };
    const orgHist = c.historico?.codigo_orgao ?? null;
    const orgsConsultados = [...new Set(audit.tentativas.map((t) => t.codigo_orgao).filter(Boolean))];
    return {
      funcionario_id: c.funcionario_id,
      nome: c.nome,
      matricula: c.matricula || null,
      cpf_mascarado: mascararCpf(c.cpf),
      grupo: c.grupo_historico,
      orgao_historico: orgHist,
      nome_historico: c.historico?.funcionario || null,
      lotacao_historico: c.historico?.lotacao || null,
      orgaos_consultados: orgsConsultados,
      consultou_apenas_org9: orgsConsultados.length === 1 && orgsConsultados[0] === '9',
      orgao_sugerido: orgHist && String(orgHist) !== '9' ? String(orgHist) : 'sem_orgao_historico',
      tentativas: audit.tentativas,
      motivo: classificarMotivoPendente(c, audit)
    };
  });
}

export function montarRelatorioAnalise({
  candidatos,
  auditPorId,
  detalhes,
  pendentesPosIds,
  metricas,
  comparacaoAntes = null
}) {
  const auditoria = montarAuditoriaCandidatos(candidatos, auditPorId, detalhes, pendentesPosIds);
  const pendentesDetalhe = auditoria.filter((a) => !a.resolvido);
  const porMotivo = {};
  for (const p of pendentesDetalhe) {
    const m = p.motivo_pendente || 'outro';
    if (!porMotivo[m]) porMotivo[m] = [];
    porMotivo[m].push({ funcionario_id: p.funcionario_id, nome: p.nome, grupo: p.grupo });
  }

  const consultasIndividuais = auditoria.reduce((s, a) => s + a.consultas_giap, 0);
  const consultasPrefixo = metricas?.consultas_giap_prefixo || 0;
  const totalConsultas = metricas?.consultas_giap || consultasIndividuais + consultasPrefixo;

  return {
    cobertura_prefixos: calcularCoberturaPrefixos(candidatos),
    auditoria_candidatos: auditoria,
    pendentes_por_motivo: porMotivo,
    cedidos: analisarCedidos(candidatos, auditPorId),
    resumo_consultas: {
      prefixos: consultasPrefixo,
      individuais_scrape: consultasIndividuais,
      total: totalConsultas,
      cache_hits: metricas?.chamadas_giap_evitadas || 0
    },
    origem_match_tipo: 'mutuamente_exclusivo',
    comparacao_antes: comparacaoAntes
  };
}

/** Baseline do 1º teste real (50 candidatos, 202608). */
export const BASELINE_TESTE_50 = {
  consultas_giap: 95,
  prefixos: 15,
  individuais: 80,
  resolvidos: 29,
  pendentes: 21,
  tempo_total_ms: 687383,
  memoria_maxima_mb: 97
};
