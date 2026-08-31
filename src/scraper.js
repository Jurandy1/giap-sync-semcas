import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { normalizarRespostaLista, inspecionarShapeResposta } from './utils.js';
import { buildRemuneracoesUrl } from './giap-http.js';
import { atualizarSessao, tentarHttpComSessao, limparSessao } from './scraper-session.js';

const PORTAL_URL = 'https://saoluis.giap.com.br/ords/saoluis/f?p=1618:6';

// IDs dos elementos APEX (extraídos do HTML da página)
const IDS = {
  competencia: 'P6_COMPETENCIA',
  codigoInstituicao: 'P6_CODIGO_INSTITUICAO_1',
  codigoOrgao: 'P6_CODIGO_ORGAO_1',
  nomeServidor: 'P6_NOME_SERVIDOR',
  quantidade: 'P6_QUANTIDADE',
  resultadoRem: 'P6_RESULTADO_REMUNERACAO',
  requestUrlRem: 'P6_REQUEST_URL_REMUNERACAO',
  botaoExecutaRem: '#B441985426547168740',
  regionRem: '#R464466892351010718',
  // /orgaos endpoint
  codigoOrgaoOG: 'P6_CODIGO_ORGAO',
  nomeOrgao: 'P6_NOME_ORGAO',
  resultadoOrgao: 'P6_RESULTADO_ORGAO',
  botaoExecutaOrgao: '#B441983336702168719',
  regionOrgao: '#R408558714892928934',
  // Filtro topo
  instituicao: 'P6_INSTITUICAO'
};

let browserInstance = null;
let remPage = null; // página reutilizada (evita reload do portal a cada busca)
let scrapesDesdeRestart = 0;
let browserLock = Promise.resolve(); // serializa scrapes (evita 2 Chrome no free tier)
let chromePathCache = undefined; // undefined=ainda não buscou; null=não achou

/** Reinicia o Chrome a cada N consultas (conservador no free tier). */
const BROWSER_RESTART_EVERY = Math.max(
  1,
  Number(process.env.GIAP_BROWSER_RESTART_EVERY || 8)
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function criarTiming() {
  return {
    tempo_criar_browser: 0,
    tempo_abrir_pagina: 0,
    tempo_carregar_apex: 0,
    tempo_preencher_campos: 0,
    tempo_executar_ajax: 0,
    tempo_esperar_resultado: 0,
    tempo_extrair_resultado: 0,
    tempo_http: 0,
    tempo_total: 0,
    pagina_reutilizada: false,
    browser_novo: false,
    metodo: 'puppeteer_apex'
  };
}

function logTimingScrape(nome, timing, extra = {}) {
  console.log(
    JSON.stringify({
      evento: 'giap_scrape_timing',
      nome: nome || null,
      ...timing,
      memoria_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      scrapes_desde_restart: scrapesDesdeRestart,
      ...extra
    })
  );
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

/** Evita dois /sync/nome ao mesmo tempo derrubarem o Chrome. */
function comLockBrowser(fn) {
  const run = browserLock.then(() => fn());
  browserLock = run.catch(() => {});
  return run;
}

/** Procura o binário chrome no cache da imagem Docker (versão pode diferir do package). */
function acharChromeNoCache(dir, profundidade = 0) {
  if (!dir || profundidade > 8) return null;
  try {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
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

/**
 * Resolve o Chrome da imagem Puppeteer Docker.
 * Com PUPPETEER_SKIP_DOWNLOAD o package npm não traz o browser — usamos o da imagem.
 */
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
    /* skip download / versão diferente */
  }

  const caches = [
    process.env.PUPPETEER_CACHE_DIR,
    '/home/pptruser/.cache/puppeteer',
    path.join(process.env.HOME || '', '.cache/puppeteer')
  ].filter(Boolean);

  for (const cache of caches) {
    const hit = acharChromeNoCache(cache);
    if (hit) {
      chromePathCache = hit;
      return chromePathCache;
    }
  }

  const candidatos = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (const p of candidatos) {
    try {
      if (fs.existsSync(p)) {
        chromePathCache = p;
        return chromePathCache;
      }
    } catch {
      /* ignore */
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
  limparSessao();
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {
      /* ignore */
    }
  }
}

async function getBrowser(timing = null) {
  if (scrapesDesdeRestart >= BROWSER_RESTART_EVERY) {
    console.log('[puppeteer] reiniciando browser (RAM) após', scrapesDesdeRestart, 'consultas');
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
      ...(process.env.PUPPETEER_DOCKER === '1'
        ? ['--single-process', '--no-zygote']
        : [])
    ]
  };
  if (!executablePath) {
    throw new Error(
      'Chrome não encontrado na imagem Docker. ' +
        'Confira se o Runtime é Docker (ghcr.io/puppeteer/puppeteer) e se ' +
        '/home/pptruser/.cache/puppeteer tem o browser.'
    );
  }
  launchOpts.executablePath = executablePath;
  console.log('[puppeteer] usando executablePath:', executablePath);

  try {
    browserInstance = await puppeteer.launch(launchOpts);
    scrapesDesdeRestart = 0;
    if (timing) {
      timing.tempo_criar_browser = msSince(tLaunch);
      timing.browser_novo = true;
    }
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes('Could not find Chrome') || msg.includes('Browser was not found')) {
      throw new Error(
        msg +
          '\n\nNo Render: use deploy via Docker (render.yaml / Dockerfile) ou ' +
          'defina o Environment Runtime como Docker. ' +
          'Build nativo Node não traz o Chrome automaticamente.'
      );
    }
    throw e;
  }
  return browserInstance;
}

/** Bloqueia recursos pesados — listener registrado uma vez por página. */
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
  // networkidle0 costuma travar no APEX; domcontentloaded + wait apex
  await page.goto(PORTAL_URL, {
    waitUntil: 'domcontentloaded',
    timeout: timeoutMs
  });
  // Chrome no Docker às vezes ainda não tem main frame estável
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

/** Uma página viva do portal — reutilizada entre consultas. */
async function getRemPage(timeoutMs, timing = null) {
  const browser = await getBrowser(timing);

  if (remPage) {
    try {
      if (remPage.isClosed?.()) {
        remPage = null;
      } else {
        const ok = await remPage.evaluate(
          () => !!(window.apex && window.apex.item && window.apex.item('P6_COMPETENCIA'))
        );
        if (ok) {
          if (timing) timing.pagina_reutilizada = true;
          try {
            const cookies = await remPage.cookies();
            atualizarSessao(cookies);
          } catch {
            /* ok */
          }
          return remPage;
        }
      }
    } catch {
      remPage = null;
    }
  }

  const tPage = Date.now();
  const page = await browser.newPage();
  if (timing) timing.tempo_abrir_pagina = msSince(tPage);

  await sleep(500);
  await page.setDefaultTimeout(timeoutMs);
  await prepararPaginaLeve(page);
  const tApex = Date.now();
  try {
    await loadPortal(page, timeoutMs);
    await expandirAccordionRem(page);
    if (timing) timing.tempo_carregar_apex = msSince(tApex);
    const cookies = await page.cookies();
    atualizarSessao(cookies);
  } catch (e) {
    await page.close().catch(() => {});
    throw e;
  }
  remPage = page;
  return remPage;
}

async function scrapeRemuneracoesOnce({
  competencia,
  codigoInstituicao = 1,
  codigoOrgao = '',
  nomeServidor = '',
  quantidade = 100,
  timeoutMs = 60000
} = {}) {
  const tTotal = Date.now();
  const timing = criarTiming();
  const nomeRaw = nomeServidor != null ? String(nomeServidor).trim() : '';
  const nome = nomeRaw.toUpperCase();
  const orgRaw = codigoOrgao != null && codigoOrgao !== '' ? String(codigoOrgao).trim() : '';
  const enviarOrgao = !!(orgRaw && nome);

  // Caminho A: HTTP com sessão APEX (Node cookies ou fetch no browser)
  const tHttp = Date.now();
  const httpHit = await tentarHttpComSessao(
    {
      competencia,
      codigoInstituicao,
      codigoOrgao: enviarOrgao ? orgRaw : '',
      nomeServidor: nome,
      quantidade
    },
    remPage
  );
  timing.tempo_http = msSince(tHttp);
  if (httpHit) {
    timing.metodo = 'http_sessao';
    timing.tempo_total = msSince(tTotal);
    logTimingScrape(nome, timing, {
      count: httpHit.count,
      status: httpHit.status,
      url: httpHit.url
    });
    return {
      data: httpHit.data,
      responseMeta: httpHit.responseMeta,
      requestUrl: httpHit.url,
      raw: '',
      codigo_orgao_enviado: enviarOrgao ? orgRaw : null,
      timing,
      metodo: 'http_sessao'
    };
  }

  // Caminho B: APEX — preenche itens, clica Executa, lê textarea (NATIVE_EXECUTE_PLSQL_CODE)
  timing.metodo = 'puppeteer_apex';
  const page = await getRemPage(timeoutMs, timing);
  scrapesDesdeRestart++;

  const token = `giap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const tFill = Date.now();
  await page.evaluate(
    (ids, params, token) => {
      apex.item(ids.competencia).setValue(String(params.competencia));
      apex.item(ids.codigoInstituicao).setValue(String(params.codigoInstituicao));
      if (params.enviarOrgao) {
        apex.item(ids.codigoOrgao).setValue(String(params.codigoOrgao), null, true);
      } else {
        apex.item(ids.codigoOrgao).setValue('', null, true);
      }
      const nomeRaw = params.nomeServidor != null ? String(params.nomeServidor).trim() : '';
      const nome = nomeRaw.toUpperCase();
      apex.item(ids.nomeServidor).setValue('', null, true);
      apex.item(ids.nomeServidor).setValue(nome, null, true);
      apex.item(ids.quantidade).setValue(String(params.quantidade));
      apex.item(ids.resultadoRem).setValue(token);
      apex.item(ids.requestUrlRem).setValue('');
    },
    IDS,
    {
      competencia,
      codigoInstituicao,
      nomeServidor: nome,
      codigoOrgao: orgRaw,
      enviarOrgao,
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
  try {
    await page.waitForFunction(
      (id, token) => {
        const v = apex.item(id).getValue();
        if (!v || !String(v).trim()) return false;
        return String(v).trim() !== token;
      },
      { timeout: timeoutMs, polling: 300 },
      IDS.resultadoRem,
      token
    );
  } catch (err) {
    timing.tempo_esperar_resultado = msSince(tWait);
    timing.tempo_total = msSince(tTotal);
    logTimingScrape(nome, timing, { erro: err.message, timeout: true });
    console.warn('[scraper] timeout remuneracoes', nomeServidor || codigoOrgao || '', err.message);
    return { data: [], requestUrl: null, raw: '', timing, metodo: 'puppeteer_apex' };
  }
  timing.tempo_esperar_resultado = msSince(tWait);

  const tExtract = Date.now();
  const { raw, requestUrl } = await page.evaluate(
    (ids) => ({
      raw: apex.item(ids.resultadoRem).getValue(),
      requestUrl: apex.item(ids.requestUrlRem).getValue()
    }),
    IDS
  );
  try {
    atualizarSessao(await page.cookies());
  } catch {
    /* ok */
  }
  timing.tempo_extrair_resultado = msSince(tExtract);

  const parsed = parseResult(raw, { requestUrl });
  timing.tempo_total = msSince(tTotal);
  logTimingScrape(nome, timing, {
    count: parsed.lista?.length || 0,
    request_url: requestUrl,
    ords_url_esperada: buildRemuneracoesUrl({
      competencia,
      codigoInstituicao,
      codigoOrgao: enviarOrgao ? orgRaw : '',
      nomeServidor: nome,
      quantidade
    })
  });

  return {
    data: parsed.lista,
    responseMeta: parsed.meta,
    requestUrl,
    raw,
    codigo_orgao_enviado: enviarOrgao ? orgRaw : null,
    timing,
    metodo: 'puppeteer_apex'
  };
}

/** Página APEX ativa (após bootstrap) — para HTTP via browser. */
export function getRemPageAtiva() {
  return remPage;
}

/**
 * Puxa servidores por remuneração. Em erro de frame/Chrome no Render, reinicia e tenta de novo.
 */
export async function scrapeRemuneracoes(opts = {}) {
  return comLockBrowser(async () => {
    const maxTentativas = Math.max(1, Number(process.env.GIAP_SCRAPE_RETRIES || 3));
    let ultimoErro = null;
    for (let t = 1; t <= maxTentativas; t++) {
      try {
        return await scrapeRemuneracoesOnce(opts);
      } catch (e) {
        ultimoErro = e;
        const msg = e?.message || String(e);
        console.warn(`[scraper] tentativa ${t}/${maxTentativas} falhou:`, msg);
        if (!ehErroFrameCedo(e) || t === maxTentativas) break;
        await closeBrowser().catch(() => {});
        await sleep(1200 * t);
      }
    }
    if (ehErroFrameCedo(ultimoErro)) {
      throw new Error(
        'Portal GIAP ocupado ou Chrome reiniciando no servidor. Aguarde 10–20s e clique em Puxar de novo. ' +
          `(${ultimoErro?.message || ultimoErro})`
      );
    }
    throw ultimoErro;
  });
}

/**
 * Lista órgãos disponíveis pra uma dada instituição.
 */
export async function scrapeOrgaos({
  codigoOrgao = '',
  nomeOrgao = '',
  codigoInstituicao = 1,
  timeoutMs = 60000
} = {}) {
  // Órgãos: página separada (não mistura com sessão de remuneracoes)
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
      await page.evaluate(
        (id, ci) => apex.item(id).setValue(String(ci)),
        IDS.instituicao,
        codigoInstituicao
      );
      await new Promise((r) => setTimeout(r, 1500));
      await loadPortal(page, timeoutMs);
    }

    await page.evaluate((sel) => {
      const reg = document.querySelector(sel);
      if (reg && reg.classList.contains('is-collapsed')) {
        reg.querySelector('.t-Button--hideShow')?.click();
      }
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
    console.log(
      JSON.stringify({
        evento: 'giap_scrape_orgaos_shape',
        response_shape: parsed.meta?.shape,
        keys: parsed.meta?.keys,
        has_items: parsed.meta?.has_items,
        has_data: parsed.meta?.has_data,
        count: parsed.meta?.count,
        erro: parsed.meta?.erro || parsed.erro || null
      })
    );
    return { data: parsed.lista, responseMeta: parsed.meta, raw };
  } finally {
    await page.close().catch(() => {});
  }
}

function parseResult(raw, ctx = {}) {
  if (!raw) {
    return {
      lista: [],
      meta: inspecionarShapeResposta(null),
      erro: null
    };
  }
  const clean = String(raw).replace(/^Resultado\s*/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error('[scraper] JSON parse failed:', e.message);
    console.error('[scraper] raw prefix:', clean.substring(0, 300));
    return {
      lista: [],
      meta: {
        ...inspecionarShapeResposta(null),
        parse_error: e.message,
        raw_prefix: clean.substring(0, 300),
        endpoint: ctx.endpoint
      },
      erro: `json_parse_failed: ${e.message}`
    };
  }

  const norm = normalizarRespostaLista(parsed, {
    rawPrefix: clean,
    requestUrl: ctx.requestUrl,
    endpoint: ctx.endpoint
  });

  if (norm.erro) {
    console.error('[scraper] formato inesperado:', norm.erro);
    console.error('[scraper] shape:', JSON.stringify(norm.meta));
  }

  return norm;
}
