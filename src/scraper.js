import puppeteer from 'puppeteer';

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

async function getBrowser() {
  if (browserInstance) {
    try {
      // Testa se ainda tá conectado
      await browserInstance.version();
      return browserInstance;
    } catch {
      browserInstance = null;
    }
  }
  browserInstance = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Em containers (Railway) estes ajudam com pouca RAM.
      // No Windows local eles derrubam o frame ("Navigating frame was detached").
      ...(process.env.PUPPETEER_DOCKER === '1'
        ? ['--single-process', '--no-zygote']
        : [])
    ]
  });
  return browserInstance;
}

async function loadPortal(page, timeoutMs) {
  await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: timeoutMs });
  await page.waitForFunction(
    () => window.apex && window.apex.item && window.apex.item('P6_COMPETENCIA'),
    { timeout: 20000 }
  );
}

/**
 * Puxa remuneração(ões) filtrando por competência + inst + órgão/nome.
 * Retorna { data: [], requestUrl, raw }.
 */
export async function scrapeRemuneracoes({
  competencia,
  codigoInstituicao = 1,
  codigoOrgao = '',
  nomeServidor = '',
  quantidade = 100,
  timeoutMs = 90000
} = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    await page.setDefaultTimeout(timeoutMs);
    await loadPortal(page, timeoutMs);
    
    // Expande o accordion do /remuneracoes (costuma vir colapsado)
    await page.evaluate((regionSel) => {
      const reg = document.querySelector(regionSel);
      if (!reg || !reg.classList.contains('is-collapsed')) return;
      // Preferir o botão com aria-expanded=false (o de abrir)
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
      { timeout: 15000 },
      IDS.regionRem
    );
    // APEX anima o body; dá um respiro pro layout
    await new Promise(r => setTimeout(r, 800));
    
    // Preenche campos e limpa resultado anterior
    await page.evaluate((ids, params) => {
      apex.item(ids.competencia).setValue(String(params.competencia));
      apex.item(ids.codigoInstituicao).setValue(String(params.codigoInstituicao));
      if (params.codigoOrgao !== '' && params.codigoOrgao != null) {
        apex.item(ids.codigoOrgao).setValue(String(params.codigoOrgao));
      } else {
        apex.item(ids.codigoOrgao).setValue('');
      }
      if (params.nomeServidor !== '' && params.nomeServidor != null) {
        apex.item(ids.nomeServidor).setValue(params.nomeServidor);
      } else {
        apex.item(ids.nomeServidor).setValue('');
      }
      apex.item(ids.quantidade).setValue(String(params.quantidade));
      apex.item(ids.resultadoRem).setValue('');
      apex.item(ids.requestUrlRem).setValue('');
    }, IDS, { competencia, codigoInstituicao, codigoOrgao, nomeServidor, quantidade });
    
    // Click via DOM (não exige bounding box)
    await page.$eval(IDS.botaoExecutaRem, (el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
    });
    
    // Aguarda resultado aparecer
    await page.waitForFunction(
      (id) => {
        const v = apex.item(id).getValue();
        return v && String(v).trim().length > 0;
      },
      { timeout: timeoutMs, polling: 500 },
      IDS.resultadoRem
    );
    
    const { raw, requestUrl } = await page.evaluate((ids) => ({
      raw: apex.item(ids.resultadoRem).getValue(),
      requestUrl: apex.item(ids.requestUrlRem).getValue()
    }), IDS);
    
    return { data: parseResult(raw), requestUrl, raw };
  } finally {
    await page.close().catch(() => {});
  }
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
  const browser = await getBrowser();
  const page = await browser.newPage();
  
  try {
    await page.setDefaultTimeout(timeoutMs);
    await loadPortal(page, timeoutMs);
    
    // Troca instituição se necessário
    const instAtual = await page.evaluate((id) => apex.item(id).getValue(), IDS.instituicao);
    if (String(instAtual) !== String(codigoInstituicao)) {
      await page.evaluate((id, ci) => apex.item(id).setValue(String(ci)), IDS.instituicao, codigoInstituicao);
      // Espera reload que o APEX dispara
      await new Promise(r => setTimeout(r, 2000));
      await loadPortal(page, timeoutMs);
    }
    
    // Expande accordion de /orgaos
    await page.evaluate((sel) => {
      const reg = document.querySelector(sel);
      if (reg && reg.classList.contains('is-collapsed')) {
        reg.querySelector('.t-Button--hideShow')?.click();
      }
    }, IDS.regionOrgao);
    
    await page.evaluate((ids, co, no) => {
      apex.item(ids.codigoOrgaoOG).setValue(String(co ?? ''));
      apex.item(ids.nomeOrgao).setValue(String(no ?? ''));
      apex.item(ids.resultadoOrgao).setValue('');
    }, IDS, codigoOrgao, nomeOrgao);
    
    await page.click(IDS.botaoExecutaOrgao);
    
    await page.waitForFunction(
      (id) => {
        const v = apex.item(id).getValue();
        return v && String(v).trim().length > 0;
      },
      { timeout: timeoutMs, polling: 500 },
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
  // O textarea às vezes vem com "Resultado\n" antes do JSON
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

export async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}
