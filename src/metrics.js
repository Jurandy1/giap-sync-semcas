/**
 * Métricas estruturadas de jobs GIAP — sem dados sensíveis (CPF nunca é logado).
 */

function memoriaSnapshot() {
  try {
    const m = process.memoryUsage();
    return {
      heap_used_mb: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
      heap_total_mb: Math.round((m.heapTotal / 1024 / 1024) * 10) / 10,
      rss_mb: Math.round((m.rss / 1024 / 1024) * 10) / 10
    };
  } catch {
    return null;
  }
}

/** true se heap > limiar (padrão 85%). */
export function memoriaPressionada(limite = Number(process.env.GIAP_MEM_PRESSURE_RATIO || 0.85)) {
  try {
    const m = process.memoryUsage();
    if (!m.heapTotal) return false;
    return m.heapUsed / m.heapTotal >= limite;
  } catch {
    return false;
  }
}

export function criarMetricas(jobId, competencia) {
  const inicio = Date.now();
  const scrapeDuracoes = [];

  const state = {
    job_id: jobId,
    competencia: Number(competencia),
    scrapes_orgao: 0,
    scrapes_letra: 0,
    scrapes_nome: 0,
    quantidade_upsert: 0,
    erros: 0,
    retries: 0,
    total_servidores: null,
    total_pendentes: null,
    total_pendentes_inicial: null,
    lote_atual: 1,
    lotes_restantes: null,
    jobs_gerados: 1,
    bulk_registros: 0
  };

  return {
    registrarScrape(tipo, duracaoMs) {
      if (tipo === 'orgao') state.scrapes_orgao++;
      else if (tipo === 'letra') state.scrapes_letra++;
      else if (tipo === 'nome') state.scrapes_nome++;
      if (Number.isFinite(duracaoMs)) scrapeDuracoes.push(duracaoMs);
    },
    registrarUpsert(n) {
      state.quantidade_upsert += Number(n) || 0;
    },
    registrarErro() {
      state.erros++;
    },
    registrarRetry() {
      state.retries++;
    },
    setPendentes(n, inicial = false) {
      state.total_pendentes = Number(n);
      if (inicial) state.total_pendentes_inicial = Number(n);
    },
    setTotalServidores(n) {
      state.total_servidores = Number(n);
    },
    setLote(atual, restantes) {
      state.lote_atual = atual;
      state.lotes_restantes = restantes;
    },
    addBulkRegistros(n) {
      state.bulk_registros += Number(n) || 0;
    },
    resumo() {
      const duracao_total_ms = Date.now() - inicio;
      const duracao_media_scrape_ms = scrapeDuracoes.length
        ? Math.round(scrapeDuracoes.reduce((a, b) => a + b, 0) / scrapeDuracoes.length)
        : 0;
      return {
        ...state,
        duracao_total_ms,
        duracao_media_scrape_ms,
        scrapes_total: state.scrapes_orgao + state.scrapes_letra + state.scrapes_nome,
        memoria: memoriaSnapshot()
      };
    },
    log(etapa) {
      const r = this.resumo();
      console.log(
        JSON.stringify({
          evento: 'giap_metricas',
          etapa: etapa || '—',
          ...r
        })
      );
      return r;
    }
  };
}
