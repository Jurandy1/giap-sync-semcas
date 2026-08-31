import 'dotenv/config';
import express from 'express';
import {
  syncPorOrgao,
  syncPorNome,
  cruzarComHR,
  verificarExoneracoes
} from './sync.js';
import { scrapeRemuneracoes, scrapeOrgaos, closeBrowser } from './scraper.js';
import { competenciaAtual, validarCompetencia } from './utils.js';
import { enriquecerFuncionarios, aplicarExoneracoes, CODIGO_ORGAO_SEMCAS } from './rhsemcas.js';
import { criarEExecutarJob, obterJob, tentarCronMensal, limparJobsOrfaos, cancelarCadeiaContinua } from './jobs.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Log de todas as requisições
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`);
  });
  next();
});

// Auth via header X-API-Key
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/') return next();
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'invalid or missing X-API-Key header' });
  }
  next();
});

app.get('/', (req, res) => {
  res.json({
    service: 'giap-sync-semcas',
    version: '1.1.0',
    endpoints: [
      'GET  /health',
      'POST /debug/benchmark       {competencia?} — HTTP vs Puppeteer (não altera folha)',
      'POST /buscar',
      'POST /sync/orgao',
      'POST /sync/orgaos',
      'POST /sync/nome',
      'POST /match/hr',
      'POST /verificar/exoneracoes',
      'POST /rhsemcas/enriquecer   {competencia?, dryRun?}',
      'POST /rhsemcas/exoneracoes  {competencia?, dryRun?}',
      'POST /jobs                  {tipo?, competencia?, dryRun?, modo?}',
      'GET  /jobs/:id',
      'POST /cron/mensal',
      'GET  /orgaos'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post('/debug/benchmark', async (req, res) => {
  try {
    const competencia = Number(req.body.competencia || competenciaAtual());
    if (!validarCompetencia(competencia)) return res.status(400).json({ error: 'competencia inválida' });
    const { fetchRemuneracoesHttp, buildRemuneracoesUrl } = await import('./giap-http.js');
    const { getSessionCookies } = await import('./scraper-session.js');
    const ORG = process.env.GIAP_CODIGO_ORGAO || '9';
    const prefixos = ['TERESINHA', 'MARIA', 'ANA'];
    const fases = {};

    fases.http_sem_sessao = await fetchRemuneracoesHttp({
      competencia,
      codigoInstituicao: 1,
      codigoOrgao: ORG,
      nomeServidor: 'TERESINHA',
      quantidade: 100
    });

    const boot = await scrapeRemuneracoes({
      competencia,
      codigoInstituicao: 1,
      codigoOrgao: ORG,
      nomeServidor: 'TERESINHA',
      quantidade: 100,
      timeoutMs: 120000
    });
    fases.bootstrap = {
      metodo: boot.metodo,
      count: boot.data?.length,
      timing: boot.timing,
      cookies: getSessionCookies()?.length || 0
    };

    fases.http_com_sessao = {};
    for (const p of prefixos) {
      fases.http_com_sessao[p] = await fetchRemuneracoesHttp({
        competencia,
        codigoInstituicao: 1,
        codigoOrgao: ORG,
        nomeServidor: p,
        quantidade: 100,
        cookies: getSessionCookies()
      });
    }

    fases.scrape_pos_sessao = {};
    for (const p of ['MARIA', 'ANA']) {
      const r = await scrapeRemuneracoes({
        competencia,
        codigoInstituicao: 1,
        codigoOrgao: ORG,
        nomeServidor: p,
        quantidade: 100,
        timeoutMs: 120000
      });
      fases.scrape_pos_sessao[p] = {
        metodo: r.metodo,
        count: r.data?.length,
        timing: r.timing
      };
    }

    res.json({
      competencia,
      endpoint: buildRemuneracoesUrl({
        competencia,
        codigoInstituicao: 1,
        codigoOrgao: ORG,
        nomeServidor: 'TERESINHA',
        quantidade: 100
      }),
      fases,
      memoria_mb: Math.round(process.memoryUsage().rss / 1024 / 1024)
    });
  } catch (e) {
    console.error('[/debug/benchmark]', e);
    res.status(500).json({ error: e.message });
  }
});

// Busca ao vivo (não persiste no Supabase)
app.post('/buscar', async (req, res) => {
  try {
    const {
      nomeServidor,
      codigoOrgao,
      codigoInstituicao = 1,
      competencia = competenciaAtual()
    } = req.body;
    if (!validarCompetencia(competencia)) return res.status(400).json({ error: 'competencia inválida (formato YYYYMM)' });
    const { data, requestUrl } = await scrapeRemuneracoes({
      competencia,
      codigoInstituicao,
      codigoOrgao: codigoOrgao || '',
      nomeServidor: nomeServidor || '',
      quantidade: 100
    });
    res.json({ competencia, requestUrl, count: data.length, data });
  } catch (e) {
    console.error('[/buscar]', e);
    res.status(500).json({ error: e.message });
  }
});

// Sync órgão inteiro (persiste)
app.post('/sync/orgao', async (req, res) => {
  try {
    const { codigoOrgao, codigoInstituicao = 1, competencia = competenciaAtual() } = req.body;
    if (!codigoOrgao) return res.status(400).json({ error: 'codigoOrgao required' });
    if (!validarCompetencia(competencia)) return res.status(400).json({ error: 'competencia inválida' });
    const resultado = await syncPorOrgao({ codigoOrgao: String(codigoOrgao), codigoInstituicao, competencia });
    res.json(resultado);
  } catch (e) {
    console.error('[/sync/orgao]', e);
    res.status(500).json({ error: e.message });
  }
});

// Sync múltiplos órgãos em sequência
app.post('/sync/orgaos', async (req, res) => {
  try {
    const {
      codigosOrgao,
      codigoInstituicao = 1,
      competencia = competenciaAtual()
    } = req.body;
    if (!Array.isArray(codigosOrgao) || codigosOrgao.length === 0) {
      return res.status(400).json({ error: 'codigosOrgao (array) required' });
    }
    if (!validarCompetencia(competencia)) return res.status(400).json({ error: 'competencia inválida' });
    
    const resultados = [];
    for (const codigoOrgao of codigosOrgao) {
      try {
        const r = await syncPorOrgao({
          codigoOrgao: String(codigoOrgao),
          codigoInstituicao,
          competencia
        });
        resultados.push({ codigoOrgao, ...r });
      } catch (e) {
        resultados.push({ codigoOrgao, success: false, erro: e.message });
      }
    }
    res.json({ total: resultados.length, resultados });
  } catch (e) {
    console.error('[/sync/orgaos]', e);
    res.status(500).json({ error: e.message });
  }
});

// Sync por nome
app.post('/sync/nome', async (req, res) => {
  try {
    const {
      nomeServidor,
      codigoInstituicao = 1,
      competencia = competenciaAtual(),
      filtrarNomeAlvo = null,
      matricula = null,
      apenasSemcas = true
    } = req.body;
    if (!nomeServidor) return res.status(400).json({ error: 'nomeServidor required' });
    if (!validarCompetencia(competencia)) return res.status(400).json({ error: 'competencia inválida' });

    const { carregarCedenciasAtuais } = await import('./rhsemcas.js');
    const ced = await carregarCedenciasAtuais();
    const mat = matricula != null ? String(matricula).trim() : '';
    const ehCedido = !!(mat && ced.mats.has(mat));
    // Matrícula vinda do RH (puxar 1 a 1): sempre libera essa mat, mesmo se o GIAP
    // vier com outro código de órgão — senão o registro some (ex.: Jurandy).
    const matsOk = mat ? [mat] : [];

    const resultado = await syncPorNome({
      nomeServidor,
      codigoInstituicao,
      competencia,
      filtrarNomeAlvo: filtrarNomeAlvo || nomeServidor,
      apenasSemcas: apenasSemcas !== false,
      matriculasOutrosOrgaosOk: matsOk,
      // Puxar 1 nome: tenta MAIÚSCULAS + prefixos (env GIAP_MAX_VARIANTES_NOME=1 no job em lote)
      maxVariantes: 4,
      meta: { ehCedido, matriculaRh: mat || null }
    });
    // Fecha Chrome após 1 nome — evita acumular RAM no Render free
    await closeBrowser().catch(() => {});
    res.json(resultado);
  } catch (e) {
    console.error('[/sync/nome]', e);
    await closeBrowser().catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// Cruza folha com HR
app.post('/match/hr', async (req, res) => {
  try {
    const params = { ...req.body };
    if (!params.competencia) params.competencia = competenciaAtual();
    if (!validarCompetencia(params.competencia)) return res.status(400).json({ error: 'competencia inválida' });
    const relatorio = await cruzarComHR(params);
    res.json(relatorio);
  } catch (e) {
    console.error('[/match/hr]', e);
    res.status(500).json({ error: e.message });
  }
});

// Verifica exonerações
app.post('/verificar/exoneracoes', async (req, res) => {
  try {
    const {
      competencia = competenciaAtual(),
      tabelaHR = 'hr_servidores',
      campoMatricula = 'matricula',
      campoExonerado = 'exonerado',
      campoDataExoneracao = 'data_exoneracao',
      campoTipoVinculo = 'tipo_vinculo'
    } = req.body;
    if (!validarCompetencia(competencia)) return res.status(400).json({ error: 'competencia inválida' });
    const r = await verificarExoneracoes({
      competencia,
      tabelaHR,
      campoMatricula,
      campoExonerado,
      campoDataExoneracao,
      campoTipoVinculo
    });
    res.json(r);
  } catch (e) {
    console.error('[/verificar/exoneracoes]', e);
    res.status(500).json({ error: e.message });
  }
});

// Lista órgãos disponíveis
app.get('/orgaos', async (req, res) => {
  try {
    const codigoInstituicao = Number(req.query.codigoInstituicao || 1);
    const { data, responseMeta, raw } = await scrapeOrgaos({ codigoInstituicao });
    res.json({
      codigoInstituicao,
      request_url: 'https://saoluis.giap.com.br/ords/saoluis/f?p=1618:6',
      response_shape: responseMeta?.shape,
      keys: responseMeta?.keys,
      has_items: responseMeta?.has_items,
      has_data: responseMeta?.has_data,
      count: data.length,
      data
    });
  } catch (e) {
    console.error('[/orgaos]', e);
    res.status(500).json({ error: e.message });
  }
});

// Enriquecimento síncrono (dry-run útil para testes)
app.post('/rhsemcas/enriquecer', async (req, res) => {
  try {
    const competencia = Number(req.body.competencia || competenciaAtual());
    const dryRun = !!req.body.dryRun;
    if (!validarCompetencia(competencia)) return res.status(400).json({ error: 'competencia inválida' });
    const relatorio = await enriquecerFuncionarios({ competencia, dryRun });
    // não devolve todos os items se muito grande
    const { items, ...rest } = relatorio;
    res.json({ ...rest, items_count: items.length, items: items.slice(0, 100) });
  } catch (e) {
    console.error('[/rhsemcas/enriquecer]', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/rhsemcas/exoneracoes', async (req, res) => {
  try {
    const competencia = Number(req.body.competencia || competenciaAtual());
    const dryRun = !!req.body.dryRun;
    if (!validarCompetencia(competencia)) return res.status(400).json({ error: 'competencia inválida' });
    const relatorio = await aplicarExoneracoes({ competencia, dryRun });
    const { items, ...rest } = relatorio;
    res.json({ ...rest, items_count: items.length, items: items.slice(0, 100) });
  } catch (e) {
    console.error('[/rhsemcas/exoneracoes]', e);
    res.status(500).json({ error: e.message });
  }
});

// Cria job em background (ciclo completo / enriquecer / exoneracoes / sync_orgao)
app.post('/jobs', async (req, res) => {
  try {
    const {
      tipo = 'ciclo_completo',
      competencia = competenciaAtual(),
      dryRun = false,
      modo = 'manual',
      createdBy = null,
      codigoOrgao = CODIGO_ORGAO_SEMCAS,
      filtros = null
    } = req.body;

    const tiposOk = [
      'ciclo_completo',
      'enriquecer',
      'exoneracoes',
      'sync_orgao',
      'sync_folha',
      'buscar_demissoes',
      'auditoria_saidas'
    ];
    if (!tiposOk.includes(tipo)) {
      return res.status(400).json({ error: `tipo inválido. Use: ${tiposOk.join(', ')}` });
    }
    if (!validarCompetencia(competencia)) return res.status(400).json({ error: 'competencia inválida' });

    const job = await criarEExecutarJob({
      tipo,
      competencia: Number(competencia),
      dryRun: !!dryRun,
      modo,
      createdBy,
      codigoOrgao: String(codigoOrgao),
      filtros
    });
    res.status(202).json({ ok: true, job });
  } catch (e) {
    console.error('[/jobs]', e);
    res.status(500).json({ error: e.message });
  }
});

/** Para a sequência automática de lotes (próximos não iniciam). O lote atual termina. */
app.post('/jobs/parar-cadeia', async (_req, res) => {
  try {
    const result = cancelarCadeiaContinua();
    res.json(result);
  } catch (e) {
    console.error('[/jobs/parar-cadeia]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/jobs/:id', async (req, res) => {
  try {
    const job = await obterJob(Number(req.params.id));
    res.json({ job });
  } catch (e) {
    console.error('[/jobs/:id]', e);
    res.status(404).json({ error: e.message });
  }
});

// Endpoint para cron diário — respeita giap_config.automatico
// Janela: a partir de dia_mes (padrão 20) até o fim do mês; competência do mês corrente.
app.post('/cron/mensal', async (req, res) => {
  try {
    const result = await tentarCronMensal();
    res.json(result);
  } catch (e) {
    console.error('[/cron/mensal]', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`giap-sync-semcas listening on :${PORT}`);
  // Jobs presos em running de antes do restart (OOM/deploy) viram error
  limparJobsOrfaos().catch((e) => console.error('[boot] limpar órfãos:', e.message));
});

async function shutdown() {
  console.log('shutting down...');
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
