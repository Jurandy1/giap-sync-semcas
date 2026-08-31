/**
 * Scraper GIAP — caminho exclusivo APEX reutilizado (sem HTTP direto).
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { normalizarRespostaLista, inspecionarShapeResposta } from './utils.js';
import { limparSessao } from './scraper-session.js';

const PORTAL_URL = 'https://saoluis.giap.com.br/ords/saoluis/f?p=1618:6';

export const IDS = {
  competencia: 'P6_COMPETENCIA',
  codigoInstituicao: 'P6_CODIGO_INSTITUICAO_1',
  codigoOrgao: 'P6_CODIGO_ORGAO_1',
  nomeServidor: 'P6_NOME_SERVIDOR',
  quantidade: 'P6_QUANTIDADE',
  resultadoRem: 'P6_RESULTADO_REMUNERACAO',
  requestUrlRem: 'P6_REQUEST_URL_REMUNERACAO',
  executaRem: 'P6_EXECUTA_REMUNERACAO',
  botaoExecutaRem: '#B441985426547168740',
  regionRem: '#R464466892351010718',
  codigoOrgaoOG: 'P6_CODIGO_ORGAO',
  nomeOrgao: 'P6_NOME_ORGAO',
  resultadoOrgao: 'P6_RESULTADO_ORGAO',
  botaoExecutaOrgao: '#B441983336702168719',
  regionOrgao: '#R408558714892928934',
  instituicao: 'P6_INSTITUICAO'
};

let browserInstance = null;
let remPage = null;
let scrapesDesdeRestart = 0;
let consultasDesdeBootstrap = 0;
let browserLock = Promise.resolve();
let chromePathCache = undefined;

const RESTART_AFTER_N = Math.max(
  1,
  Number(process.env.GIAP_RESTART_BROWSER_AFTER_N || process.env.GIAP_BROWSER_RESTART_EVERY || 20)
);

const QUERY_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.GIAP_SCRAPE_TIMEOUT_MS || 30000)
);

const PORTAL_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.GIAP_PORTAL_TIMEOUT_MS || 60000)
);

const scrapeMetrics = {
  bootstrap_count: 0,
  restart_count: 0,
  consultas_desde_bootstrap: 0,
  tempo_bootstrap_ms: 0,
  tempo_consultas_ms: 0,
  memoria_inicial_mb: null,
  memoria_maxima_mb: 0
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function memMb() {
  const mb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  if (scrapeMetrics.memoria_inicial_mb == null) scrapeMetrics.memoria_inicial_mb = mb;
  scrapeMetrics.memoria_maxima_mb = Math.max(scrapeMetrics.memoria_maxima_mb, mb);
  return mb;
}

function criarTiming() {
  return {
    tempo_criar_browser: 0,
    tempo_abrir_pagina: 0,
    tempo_carregar_apex: 0,
    tempo_preencher_campos: 0,
    tempo_executar_ajax: 0,
    tempo_esperar_resultado: 0,
    tempo_extrair_resultado: 0,
    tempo_total: 0,
    pagina_reutilizada: false,
    browser_novo: false,
    bootstrap: false,
    metodo: 'puppeteer_apex',
    consultas_desde_bootstrap: consultasDesdeBootstrap,
    restart_count: scrapeMetrics.restart_count
  };
}

function logTimingScrape(nome, timing, extra = {}) {
  console.log(
    JSON.stringify({
      evento: 'giap_scrape_timing',
      nome: nome || null,
      ...timing,
      memoria_mb: memMb(),
      scrapes_desde_restart: scrapesDesdeRestart,
      consultas_desde_bootstrap: consultasDesdeBootstrap,
      ...extra
    })
  );
}

export function getScrapeMetrics() {
  return {
    ...scrapeMetrics,
    memoria_final_mb: memMb(),
    consultas_desde_bootstrap: consultasDesdeBootstrap,
    restart_after_n: RESTART_AFTER_N,
    query_timeout_ms: QUERY_TIMEOUT_MS
  };
}

function msSince(t0) {
  return Date.now() - t0;
}

function ehErroFrameCedo(err) {
  const msg = String(err?.message || err || '');
  return (
    /main frame too early/i.test(msg) ||
    /detached Frame/i.test(msg) ||
    /Target closed/i.test(msg) ||
    /Session closed/i.test(msg) ||
    /Protocol error/i.test(msg) ||
    /Execution context was destroyed/i.test(msg)
  );
}

function comLockBrowser(fn) {
  const run = browserLock.then(() => fn());
  browserLock = run.catch(() => {});
  return run;
}

function acharChromeNoCache(dir, profundidade = 0) {
  if (!dir || profundidade > 8) return null;
  try {
    if (!fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isFile() && (e.name === 'chrome' || e.name === 'google-chrome')) {
        try {
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        } catch {
          return full;
        }
      }
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const hit = acharChromeNoCache(full, profundidade + 1);
        if (hit) return hit;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function resolverExecutablePath() {
  if (chromePathCache !== undefined) return chromePathCache || undefined;
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    chromePathCache = process.env.PUPPETEER_EXECUTABLE_PATH;
    return chromePathCache;
  }
  try {
    const builtIn = puppeteer.executablePath();
    if (builtIn && fs.existsSync(builtIn)) {
      chromePathCache = builtIn;
      return chromePathCache;
    }
  } catch {
    /* ok */
  }
  for (const cache of [
    process.env.PUPPETEER_CACHE_DIR,
    '/home/pptruser/.cache/puppeteer',
    path.join(process.env.HOME || '', '.cache/puppeteer')
  ].filter(Boolean)) {
    const hit = acharChromeNoCache(cache);
    if (hit) {
      chromePathCache = hit;
      return chromePathCache;
    }
  }
  for (const p of ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    if (fs.existsSync(p)) {
      chromePathCache = p;
      return chromePathCache;
    }
  }
  chromePathCache = null;
  return undefined;
}

async function fecharPaginaRem() {
  if (remPage) {
    await remPage.close().catch(() => {});
    remPage = null;
  }
}

export async function closeBrowser() {
  await fecharPaginaRem();
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
  scrapesDesdeRestart = 0;
  consultasDesdeBootstrap = 0;
  limparSessao();
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {
      /* ignore */
    }
  }
}

/** Verifica se a página APEX continua operacional. */
export async function healthCheckPaginaApex(page = remPage) {
  if (!page) return { ok: false, motivo: 'sem_pagina' };
  if (page.isClosed?.()) return { ok: false, motivo: 'page_closed' };
  try {
    const h = await page.evaluate((ids) => {
      const ready = document.readyState;
      const apexOk = !!(window.apex && window.apex.item);
      const campoIds = [ids.competencia, ids.nomeServidor, ids.resultadoRem, ids.requestUrlRem];
      const idsOk = campoIds.every((id) => {
        try {
          return !!apex.item(id);
        } catch {
          return false;
        }
      });
      const botaoOk = !!document.querySelector(ids.botaoExecutaRem);
      let executaVal = null;
      try {
        executaVal = apex.item(ids.executaRem)?.getValue?.();
      } catch {
        /* item opcional */
      }
      return {
        ok: (ready === 'complete' || ready === 'interactive') && apexOk && idsOk && botaoOk,
        readyState: ready,
        apexOk,
        idsOk,
        botaoOk,
        executa_val: executaVal
      };
    }, IDS);
    return h;
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

async function recuperarPaginaApex(timing = null) {
  console.log(JSON.stringify({ evento: 'giap_recuperar_pagina', motivo: 'health_fail_ou_timeout' }));
  await fecharPaginaRem();
  return getRemPage(PORTAL_TIMEOUT_MS, timing, { forcar_novo_bootstrap: true });
}

async function getBrowser(timing = null) {
  if (scrapesDesdeRestart >= RESTART_AFTER_N) {
    console.log(
      JSON.stringify({
        evento: 'giap_browser_restart',
        consultas: scrapesDesdeRestart,
        limite: RESTART_AFTER_N
      })
    );
    scrapeMetrics.restart_count++;
    await closeBrowser();
  }

  if (browserInstance) {
    try {
      await browserInstance.version();
      if (timing) {
        timing.tempo_criar_browser = 0;
        timing.browser_novo = false;
      }
      return browserInstance;
    } catch {
      browserInstance = null;
      remPage = null;
    }
  }

  const tLaunch = Date.now();
  const executablePath = resolverExecutablePath();
  const launchOpts = {
    headless: 'new',
    protocolTimeout: Math.max(120000, Number(process.env.GIAP_PROTOCOL_TIMEOUT_MS || 180000)),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--no-first-run',
      '--metrics-recording-only',
      '--disable-software-rasterizer',
      '--disable-features=TranslateUI,BlinkGenPropertyTrees,NetworkServiceInProcess2',
      '--renderer-process-limit=1',
      '--js-flags=--max-old-space-size=96',
      ...(process.env.PUPPETEER_DOCKER === '1' ? ['--single-process', '--no-zygote'] : [])
    ]
  };
  if (!executablePath) {
    throw new Error('Chrome não encontrado na imagem Docker.');
  }
  launchOpts.executablePath = executablePath;

  browserInstance = await puppeteer.launch(launchOpts);
  scrapesDesdeRestart = 0;
  consultasDesdeBootstrap = 0;
  if (timing) {
    timing.tempo_criar_browser = msSince(tLaunch);
    timing.browser_novo = true;
  }
  return browserInstance;
}

async function prepararPaginaLeve(page) {
  if (page._giapInterceptionReady) return;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const tipo = req.resourceType();
    if (tipo === 'image' || tipo === 'font' || tipo === 'media' || tipo === 'stylesheet') {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
  page._giapInterceptionReady = true;
}

async function loadPortal(page, timeoutMs) {
  await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await sleep(400);
  await page.waitForFunction(
    () => window.apex && window.apex.item && window.apex.item('P6_COMPETENCIA'),
    { timeout: 25000 }
  );
}

async function expandirAccordionRem(page) {
  await page.evaluate((regionSel) => {
    const reg = document.querySelector(regionSel);
    if (!reg || !reg.classList.contains('is-collapsed')) return;
    const openBtn =
      reg.querySelector('button.t-Button--hideShow[aria-expanded="false"]') ||
      reg.querySelector('button.t-Button--hideShow') ||
      reg.querySelector('.t-Button--hideShow');
    openBtn?.click();
  }, IDS.regionRem);
  await page.waitForFunction(
    (regionSel) => {
      const reg = document.querySelector(regionSel);
      return !!reg && !reg.classList.contains('is-collapsed');
    },
    { timeout: 10000 },
    IDS.regionRem
  );
  await sleep(300);
}

/** Bootstrap: abre portal uma única vez. Reutilizado em todas as consultas seguintes. */
async function getRemPage(timeoutMs, timing = null, opts = {}) {
  const browser = await getBrowser(timing);

  if (remPage && !opts.forcar_novo_bootstrap) {
    const health = await healthCheckPaginaApex(remPage);
    if (health.ok) {
      if (timing) timing.pagina_reutilizada = true;
      return remPage;
    }
    console.warn(JSON.stringify({ evento: 'giap_pagina_invalida', health }));
    await fecharPaginaRem();
  }

  const tBoot = Date.now();
  const page = await browser.newPage();
  if (timing) timing.tempo_abrir_pagina = 0;

  await sleep(300);
  await page.setDefaultTimeout(timeoutMs);
  await prepararPaginaLeve(page);

  const tApex = Date.now();
  await loadPortal(page, timeoutMs);
  await expandirAccordionRem(page);

  const bootMs = msSince(tBoot);
  scrapeMetrics.bootstrap_count++;
  scrapeMetrics.tempo_bootstrap_ms += bootMs;
  consultasDesdeBootstrap = 0;

  if (timing) {
    timing.tempo_carregar_apex = msSince(tApex);
    timing.bootstrap = true;
    timing.pagina_reutilizada = false;
  }

  remPage = page;
  return remPage;
}

function novoTokenExecucao() {
  return `giap_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Limpa estado antes de nova consulta — evita reutilizar resultado anterior. */
async function limparEstadoConsulta(page, token) {
  await page.evaluate(
    (ids, token) => {
      apex.item(ids.resultadoRem).setValue(token);
      apex.item(ids.requestUrlRem).setValue('');
      try {
        const ex = apex.item(ids.executaRem);
        if (ex) ex.setValue('0');
      } catch {
        /* ok */
      }
    },
    IDS,
    token
  );
}

/** Espera resposta da execução ATUAL (valor !== token de placeholder). */
async function esperarResultadoConsulta(page, token, timeoutMs) {
  await page.waitForFunction(
    (id, token) => {
      const v = apex.item(id).getValue();
      if (!v || !String(v).trim()) return false;
      const s = String(v).trim();
      if (s === token) return false;
      // JSON válido ou mensagem PL/SQL de erro
      if (s.startsWith('{') || s.startsWith('[')) {
        try {
          JSON.parse(s.replace(/^Resultado\s*/i, '').trim());
          return true;
        } catch {
          return s.length > 20;
        }
      }
      return s.length > 5 && !s.startsWith('giap_');
    },
    { timeout: timeoutMs, polling: 250 },
    IDS.resultadoRem,
    token
  );
}

async function executarConsultaApex(page, params, timing) {
  const { competencia, codigoInstituicao, codigoOrgao, nomeServidor, quantidade, timeoutMs } = params;
  const nome = String(nomeServidor).trim().toUpperCase();
  const orgRaw = codigoOrgao != null && codigoOrgao !== '' ? String(codigoOrgao).trim() : '';
  const enviarOrgao = !!(orgRaw && nome);
  const token = novoTokenExecucao();

  const tFill = Date.now();
  await limparEstadoConsulta(page, token);
  await page.evaluate(
    (ids, p, token) => {
      apex.item(ids.competencia).setValue(String(p.competencia));
      apex.item(ids.codigoInstituicao).setValue(String(p.codigoInstituicao));
      if (p.enviarOrgao) {
        apex.item(ids.codigoOrgao).setValue(String(p.codigoOrgao), null, true);
      } else {
        apex.item(ids.codigoOrgao).setValue('', null, true);
      }
      apex.item(ids.nomeServidor).setValue('', null, true);
      apex.item(ids.nomeServidor).setValue(p.nomeServidor, null, true);
      apex.item(ids.quantidade).setValue(String(p.quantidade));
      apex.item(ids.resultadoRem).setValue(token);
      apex.item(ids.requestUrlRem).setValue('');
      try {
        const ex = apex.item(ids.executaRem);
        if (ex) ex.setValue('0');
      } catch {
        /* ok */
      }
    },
    IDS,
    {
      competencia,
      codigoInstituicao,
      codigoOrgao: orgRaw,
      enviarOrgao,
      nomeServidor: nome,
      quantidade
    },
    token
  );
  timing.tempo_preencher_campos = msSince(tFill);

  const tClick = Date.now();
  await page.$eval(IDS.botaoExecutaRem, (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
  });
  timing.tempo_executar_ajax = msSince(tClick);

  const tWait = Date.now();
  await esperarResultadoConsulta(page, token, timeoutMs);
  timing.tempo_esperar_resultado = msSince(tWait);

  const tExtract = Date.now();
  const { raw, requestUrl } = await page.evaluate(
    (ids) => ({
      raw: apex.item(ids.resultadoRem).getValue(),
      requestUrl: apex.item(ids.requestUrlRem).getValue()
    }),
    IDS
  );
  timing.tempo_extrair_resultado = msSince(tExtract);

  const parsed = parseResult(raw, { requestUrl });
  return {
    data: parsed.lista,
    responseMeta: parsed.meta,
    requestUrl,
    raw,
    codigo_orgao_enviado: enviarOrgao ? orgRaw : null,
    erro: parsed.erro,
    token_execucao: token
  };
}

async function scrapeRemuneracoesOnce({
  competencia,
  codigoInstituicao = 1,
  codigoOrgao = '',
  nomeServidor = '',
  quantidade = 100,
  timeoutMs = QUERY_TIMEOUT_MS
} = {}) {
  const tTotal = Date.now();
  const timing = criarTiming();
  const nome = String(nomeServidor ?? '').trim().toUpperCase();
  const queryTimeout = Math.min(timeoutMs, QUERY_TIMEOUT_MS);

  timing.metodo = 'puppeteer_apex';
  let page = await getRemPage(PORTAL_TIMEOUT_MS, timing);
  scrapesDesdeRestart++;
  consultasDesdeBootstrap++;

  const params = { competencia, codigoInstituicao, codigoOrgao, nomeServidor: nome, quantidade, timeoutMs: queryTimeout };

  try {
    const result = await executarConsultaApex(page, params, timing);
    timing.tempo_total = msSince(tTotal);
    scrapeMetrics.tempo_consultas_ms += timing.tempo_total;
    logTimingScrape(nome, timing, { count: result.data?.length || 0, status: 'ok' });
    return { ...result, timing, metodo: 'puppeteer_apex', status: 'ok' };
  } catch (err) {
    timing.tempo_esperar_resultado = timing.tempo_esperar_resultado || msSince(tTotal);
    const health = await healthCheckPaginaApex(page);
    console.warn(
      JSON.stringify({
        evento: 'giap_consulta_falhou',
        prefixo: nome,
        erro: err.message,
        timeout: /timeout|exceeded/i.test(err.message),
        health
      })
    );

    // Recuperação: mesma página ou re-bootstrap uma vez
    try {
      page = await recuperarPaginaApex(timing);
      scrapesDesdeRestart++;
      consultasDesdeBootstrap++;
      const result = await executarConsultaApex(page, params, timing);
      timing.recuperado = true;
      timing.tempo_total = msSince(tTotal);
      scrapeMetrics.tempo_consultas_ms += timing.tempo_total;
      logTimingScrape(nome, timing, { count: result.data?.length || 0, status: 'ok_recuperado' });
      return { ...result, timing, metodo: 'puppeteer_apex', status: 'ok_recuperado' };
    } catch (err2) {
      timing.tempo_total = msSince(tTotal);
      timing.recuperado = false;
      logTimingScrape(nome, timing, { erro: err2.message, timeout: true, status: 'falha' });
      return {
        data: [],
        requestUrl: null,
        raw: '',
        timing,
        metodo: 'puppeteer_apex',
        status: 'timeout',
        erro: err2.message
      };
    }
  }
}

export function getRemPageAtiva() {
  return remPage;
}

export async function scrapeRemuneracoes(opts = {}) {
  return comLockBrowser(async () => {
    const maxTentativas = Math.max(1, Number(process.env.GIAP_SCRAPE_RETRIES || 2));
    let ultimoErro = null;
    for (let t = 1; t <= maxTentativas; t++) {
      try {
        return await scrapeRemuneracoesOnce(opts);
      } catch (e) {
        ultimoErro = e;
        console.warn(`[scraper] tentativa ${t}/${maxTentativas}:`, e.message);
        if (!ehErroFrameCedo(e) || t === maxTentativas) break;
        await closeBrowser().catch(() => {});
        await sleep(1000 * t);
      }
    }
    if (ehErroFrameCedo(ultimoErro)) {
      throw new Error(`Portal GIAP indisponível (${ultimoErro?.message})`);
    }
    throw ultimoErro;
  });
}

export async function scrapeOrgaos({
  codigoOrgao = '',
  nomeOrgao = '',
  codigoInstituicao = 1,
  timeoutMs = PORTAL_TIMEOUT_MS
} = {}) {
  await fecharPaginaRem();
  const browser = await getBrowser();
  const page = await browser.newPage();
  scrapesDesdeRestart++;

  try {
    await page.setDefaultTimeout(timeoutMs);
    await prepararPaginaLeve(page);
    await loadPortal(page, timeoutMs);

    const instAtual = await page.evaluate((id) => apex.item(id).getValue(), IDS.instituicao);
    if (String(instAtual) !== String(codigoInstituicao)) {
      await page.evaluate((id, ci) => apex.item(id).setValue(String(ci)), IDS.instituicao, codigoInstituicao);
      await sleep(1500);
      await loadPortal(page, timeoutMs);
    }

    await page.evaluate((sel) => {
      const reg = document.querySelector(sel);
      if (reg?.classList.contains('is-collapsed')) reg.querySelector('.t-Button--hideShow')?.click();
    }, IDS.regionOrgao);

    await page.evaluate(
      (ids, co, no) => {
        apex.item(ids.codigoOrgaoOG).setValue(String(co ?? ''));
        apex.item(ids.nomeOrgao).setValue(String(no ?? ''));
        apex.item(ids.resultadoOrgao).setValue('');
      },
      IDS,
      codigoOrgao,
      nomeOrgao
    );

    await page.click(IDS.botaoExecutaOrgao);
    await page.waitForFunction(
      (id) => {
        const v = apex.item(id).getValue();
        return v && String(v).trim().length > 0;
      },
      { timeout: timeoutMs, polling: 400 },
      IDS.resultadoOrgao
    );

    const raw = await page.evaluate((ids) => apex.item(ids.resultadoOrgao).getValue(), IDS);
    const parsed = parseResult(raw, { endpoint: 'orgaos' });
    return { data: parsed.lista, responseMeta: parsed.meta, raw };
  } finally {
    await page.close().catch(() => {});
  }
}

function parseResult(raw, ctx = {}) {
  if (!raw) {
    return { lista: [], meta: inspecionarShapeResposta(null), erro: null };
  }
  const clean = String(raw).replace(/^Resultado\s*/i, '').trim();
  if (clean.startsWith('giap_')) {
    return { lista: [], meta: inspecionarShapeResposta(null), erro: 'token_nao_substituido' };
  }
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    return {
      lista: [],
      meta: { ...inspecionarShapeResposta(null), parse_error: e.message, raw_prefix: clean.substring(0, 120) },
      erro: `json_parse_failed: ${e.message}`
    };
  }
  return normalizarRespostaLista(parsed, { rawPrefix: clean, requestUrl: ctx.requestUrl, endpoint: ctx.endpoint });
}
