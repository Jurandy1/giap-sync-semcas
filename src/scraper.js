import puppeteer from 'puppeteer';
import fs from 'fs';

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

/** Reinicia o Chrome a cada N consultas (free tier: baixo). */
const BROWSER_RESTART_EVERY = Math.max(
  1,
  Number(process.env.GIAP_BROWSER_RESTART_EVERY || 3)
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Caminhos comuns de Chrome/Chromium em Docker/Linux (fallback). */
function resolverExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidatos = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (const p of candidatos) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
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
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch {
      /* ignore */
    }
  }
}

async function getBrowser() {
  if (scrapesDesdeRestart >= BROWSER_RESTART_EVERY) {
    console.log('[puppeteer] reiniciando browser (RAM) após', scrapesDesdeRestart, 'consultas');
    await closeBrowser();
  }

  if (browserInstance) {
    try {
      await browserInstance.version();
      return browserInstance;
    } catch {
      browserInstance = null;
      remPage = null;
    }
  }

  const executablePath = resolverExecutablePath();
  const launchOpts = {
    headless: 'new',
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
  if (executablePath) {
    launchOpts.executablePath = executablePath;
    console.log('[puppeteer] usando executablePath:', executablePath);
  }

  try {
    browserInstance = await puppeteer.launch(launchOpts);
    scrapesDesdeRestart = 0;
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

/** Bloqueia imagem/fonte/mídia pra caber em 512MB. */
async function prepararPaginaLeve(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const tipo = req.resourceType();
    if (tipo === 'image' || tipo === 'font' || tipo === 'media' || tipo === 'stylesheet') {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });
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
async function getRemPage(timeoutMs) {
  const browser = await getBrowser();

  if (remPage) {
    try {
      if (remPage.isClosed?.()) {
        remPage = null;
      } else {
        const ok = await remPage.evaluate(
          () => !!(window.apex && window.apex.item && window.apex.item('P6_COMPETENCIA'))
        );
        if (ok) return remPage;
      }
    } catch {
      remPage = null;
    }
  }

  const page = await browser.newPage();
  await sleep(500); // race comum no Render: newPage → goto cedo demais
  await page.setDefaultTimeout(timeoutMs);
  await prepararPaginaLeve(page);
  try {
    await loadPortal(page, timeoutMs);
    await expandirAccordionRem(page);
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
  if (codigoOrgao !== '' && codigoOrgao != null) {
    console.warn(
      '[scraper] codigoOrgao ignorado no portal (retornaria vazio). Filtre pós-scrape. Recebido:',
      codigoOrgao
    );
  }

  const page = await getRemPage(timeoutMs);
  scrapesDesdeRestart++;

  const token = `giap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await page.evaluate(
    (ids, params, token) => {
      apex.item(ids.competencia).setValue(String(params.competencia));
      apex.item(ids.codigoInstituicao).setValue(String(params.codigoInstituicao));
      apex.item(ids.codigoOrgao).setValue('', null, true);
      const nomeRaw = params.nomeServidor != null ? String(params.nomeServidor).trim() : '';
      // Portal indexa em MAIÚSCULAS — minúsculas do RH costumam retornar vazio
      const nome = nomeRaw.toUpperCase();
      apex.item(ids.nomeServidor).setValue('', null, true);
      apex.item(ids.nomeServidor).setValue(nome, null, true);
      apex.item(ids.quantidade).setValue(String(params.quantidade));
      apex.item(ids.resultadoRem).setValue(token);
      apex.item(ids.requestUrlRem).setValue('');
    },
    IDS,
    { competencia, codigoInstituicao, nomeServidor, quantidade },
    token
  );

  await page.$eval(IDS.botaoExecutaRem, (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
  });

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
    console.warn('[scraper] timeout remuneracoes', nomeServidor || codigoOrgao || '', err.message);
    return { data: [], requestUrl: null, raw: '' };
  }

  const { raw, requestUrl } = await page.evaluate(
    (ids) => ({
      raw: apex.item(ids.resultadoRem).getValue(),
      requestUrl: apex.item(ids.requestUrlRem).getValue()
    }),
    IDS
  );

  return { data: parseResult(raw), requestUrl, raw };
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
    return { data: parseResult(raw), raw };
  } finally {
    await page.close().catch(() => {});
  }
}

function parseResult(raw) {
  if (!raw) return [];
  const clean = String(raw).replace(/^Resultado\s*/i, '').trim();
  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.error('[scraper] JSON parse failed:', e.message);
    console.error('[scraper] raw prefix:', clean.substring(0, 300));
    return [];
  }
}
