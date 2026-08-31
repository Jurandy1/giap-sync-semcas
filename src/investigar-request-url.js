/**
 * Investigação P6_REQUEST_URL_REMUNERACAO — não altera folha, matching ou sync.
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { buildRemuneracoesUrl, fetchRemuneracoesHttp, fetchRemuneracoesViaPage } from './giap-http.js';
import { normalizarRespostaLista } from './utils.js';
import { ehFolhaSemcas } from './matching.js';
import {
  mascararUrl,
  compararUrls,
  extrairItensAjax,
  mascararValor
} from './url-mask.js';
import { closeBrowser } from './scraper.js';

const PORTAL_URL = 'https://saoluis.giap.com.br/ords/saoluis/f?p=1618:6';
const URL_PUBLICA_BASE = buildRemuneracoesUrl({
  competencia: 202608,
  codigoInstituicao: 1,
  codigoOrgao: '9',
  nomeServidor: 'TERESINHA',
  quantidade: 100
});

const IDS = {
  competencia: 'P6_COMPETENCIA',
  codigoInstituicao: 'P6_CODIGO_INSTITUICAO_1',
  codigoOrgao: 'P6_CODIGO_ORGAO_1',
  nomeServidor: 'P6_NOME_SERVIDOR',
  quantidade: 'P6_QUANTIDADE',
  resultadoRem: 'P6_RESULTADO_REMUNERACAO',
  requestUrlRem: 'P6_REQUEST_URL_REMUNERACAO',
  botaoExecutaRem: '#B441985426547168740',
  regionRem: '#R464466892351010718'
};

const PREFIXOS = ['TERESINHA', 'MARIA', 'ANA'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolverExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  try {
    const builtIn = puppeteer.executablePath();
    if (builtIn && fs.existsSync(builtIn)) return builtIn;
  } catch {
    /* ok */
  }
  for (const p of [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    path.join(process.env.HOME || '', '.cache/puppeteer')
  ]) {
    if (p && fs.existsSync(p) && !p.includes('puppeteer')) return p;
  }
  return undefined;
}

function resumoResultado(raw) {
  if (!raw) return { quantidade: 0, quantidade_semcas: 0, primeiro_nome: null };
  const clean = String(raw).replace(/^Resultado\s*/i, '').trim();
  try {
    const parsed = JSON.parse(clean);
    const { lista } = normalizarRespostaLista(parsed, {});
    const primeiro = lista[0];
    return {
      quantidade: lista.length,
      quantidade_semcas: lista.filter((i) => ehFolhaSemcas(i)).length,
      primeiro_nome: primeiro?.funcionario || null,
      primeiro_matricula: primeiro?.matricula ?? null,
      shape: typeof parsed
    };
  } catch (e) {
    return { quantidade: 0, erro_parse: e.message, raw_tamanho: clean.length };
  }
}

async function testarUrl(url, page, cookies) {
  if (!url) {
    return {
      browser: { ok: false, erro: 'url_vazia' },
      node: { ok: false, erro: 'url_vazia' }
    };
  }

  const browserRes = page
    ? await fetchRemuneracoesViaPage(page, { url, timeoutMs: 30000 })
    : { ok: false, erro: 'sem_pagina' };

  const nodeRes = await fetchRemuneracoesHttp({
    url,
    cookies: cookies || [],
    timeoutMs: 30000
  });

  const fmt = (r) => ({
    status: r.status ?? null,
    tempo_ms: r.tempo_ms,
    ok: !!r.ok,
    count: r.count ?? 0,
    content_type: r.content_type || null,
    primeiro_nome: r.primeiro?.funcionario || null,
    erro: r.erro ? mascararValor(String(r.erro).slice(0, 120)) : null,
    via: r.via
  });

  return {
    browser: fmt(browserRes),
    node: fmt(nodeRes)
  };
}

async function executarConsultaApex(page, opts, ajaxCapturas) {
  const { competencia, codigoInstituicao, codigoOrgao, nomeServidor, quantidade, timeoutMs } = opts;
  const nome = String(nomeServidor).trim().toUpperCase();
  const t0 = Date.now();
  const token = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  ajaxCapturas.length = 0;

  await page.evaluate(
    (ids, params, token) => {
      apex.item(ids.competencia).setValue(String(params.competencia));
      apex.item(ids.codigoInstituicao).setValue(String(params.codigoInstituicao));
      apex.item(ids.codigoOrgao).setValue(String(params.codigoOrgao), null, true);
      apex.item(ids.nomeServidor).setValue('', null, true);
      apex.item(ids.nomeServidor).setValue(params.nomeServidor, null, true);
      apex.item(ids.quantidade).setValue(String(params.quantidade));
      apex.item(ids.resultadoRem).setValue(token);
      apex.item(ids.requestUrlRem).setValue('');
    },
    IDS,
    { competencia, codigoInstituicao, codigoOrgao, nomeServidor: nome, quantidade },
    token
  );

  await page.$eval(IDS.botaoExecutaRem, (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
  });

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

  const { raw, requestUrl } = await page.evaluate(
    (ids) => ({
      raw: apex.item(ids.resultadoRem).getValue(),
      requestUrl: apex.item(ids.requestUrlRem).getValue()
    }),
    IDS
  );

  const cookies = await page.cookies();
  const urlPublica = buildRemuneracoesUrl({
    competencia,
    codigoInstituicao,
    codigoOrgao,
    nomeServidor: nome,
    quantidade
  });

  const testes = await testarUrl(requestUrl, page, cookies);
  const testeUrlPublica = await testarUrl(urlPublica, page, cookies);

  return {
    prefixo: nome,
    tempo_apex_ms: Date.now() - t0,
    request_url: mascararUrl(requestUrl),
    request_url_bruta_tem_valor: !!(requestUrl && String(requestUrl).trim()),
    url_publica_documentada: mascararUrl(urlPublica),
    comparacao: compararUrls(requestUrl, urlPublica),
    resultado: resumoResultado(raw),
    ajax_respostas: ajaxCapturas.map((a) => ({
      url_mascarada: mascararUrl(a.url)?.mascarada || a.url,
      status_http: a.status,
      tempo_ms: a.tempo_ms,
      content_type: a.content_type,
      tamanho_bytes: a.tamanho_bytes,
      itens: a.itens
    })),
    teste_request_url_apex: testes,
    teste_url_publica: testeUrlPublica
  };
}

/**
 * @param {{ competencia?: number, prefixos?: string[], timeoutMs?: number }} opts
 */
export async function executarInvestigacaoRequestUrl(opts = {}) {
  const competencia = Number(opts.competencia || 202608);
  const prefixos = opts.prefixos || PREFIXOS;
  const timeoutMs = Number(opts.timeoutMs || 120000);
  const codigoInstituicao = 1;
  const codigoOrgao = '9';
  const quantidade = 100;

  // Isola do scraper de produção
  await closeBrowser().catch(() => {});

  const tInicio = Date.now();
  const relatorio = {
    competencia,
    codigo_instituicao: codigoInstituicao,
    codigo_orgao: codigoOrgao,
    quantidade,
    endpoint_publico_referencia: mascararUrl(URL_PUBLICA_BASE),
    consultas: [],
    conclusao: null
  };

  const executablePath = resolverExecutablePath();
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    protocolTimeout: Math.max(120000, Number(process.env.GIAP_PROTOCOL_TIMEOUT_MS || 180000)),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      ...(process.env.PUPPETEER_DOCKER === '1' ? ['--single-process', '--no-zygote'] : [])
    ]
  });

  let page;
  try {
    page = await browser.newPage();
    await page.setDefaultTimeout(timeoutMs);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const tipo = req.resourceType();
      if (tipo === 'image' || tipo === 'font' || tipo === 'media' || tipo === 'stylesheet') {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    const ajaxCapturas = [];
    page.on('response', async (res) => {
      const url = res.url();
      if (!/\/wwv_flow\.ajax(?!\w)/i.test(url) && !url.includes('wwv_flow.ajax')) return;
      const tAjax = Date.now();
      try {
        const ct = res.headers()['content-type'] || '';
        const texto = await res.text();
        ajaxCapturas.push({
          url,
          status: res.status(),
          tempo_ms: Date.now() - tAjax,
          content_type: ct,
          tamanho_bytes: Buffer.byteLength(texto, 'utf8'),
          itens: extrairItensAjax(texto)
        });
      } catch {
        ajaxCapturas.push({ url, status: res.status(), erro: 'body_nao_lido' });
      }
    });

    const tBoot = Date.now();
    await page.goto(PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await sleep(400);
    await page.waitForFunction(
      () => window.apex && window.apex.item && window.apex.item('P6_COMPETENCIA'),
      { timeout: 25000 }
    );
    await page.evaluate((regionSel) => {
      const reg = document.querySelector(regionSel);
      if (!reg || !reg.classList.contains('is-collapsed')) return;
      reg.querySelector('button.t-Button--hideShow')?.click();
    }, IDS.regionRem);
    await sleep(400);

    relatorio.bootstrap = {
      tempo_ms: Date.now() - tBoot,
      portal: PORTAL_URL,
      accordion_aberto: true
    };

    for (const prefixo of prefixos) {
      const consulta = await executarConsultaApex(
        page,
        { competencia, codigoInstituicao, codigoOrgao, nomeServidor: prefixo, quantidade, timeoutMs },
        ajaxCapturas
      );
      relatorio.consultas.push(consulta);
      await sleep(500);
    }

    // Análise comparativa entre prefixos
    const urls = relatorio.consultas.map((c) => c.request_url?.path).filter(Boolean);
    const pathsUnicos = [...new Set(urls)];
    relatorio.variacao_entre_prefixos = {
      paths_unicos: pathsUnicos,
      mesma_estrutura_path: pathsUnicos.length <= 1,
      parametros_por_prefixo: relatorio.consultas.map((c) => ({
        prefixo: c.prefixo,
        parametros: c.request_url?.parametros || {}
      }))
    };

    relatorio.conclusao = inferirConclusao(relatorio);
    relatorio.duracao_total_ms = Date.now() - tInicio;
    return relatorio;
  } finally {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
    await closeBrowser().catch(() => {});
  }
}

function inferirConclusao(relatorio) {
  const cs = relatorio.consultas || [];
  if (!cs.length) return { resposta: 'sem_dados' };

  const temUrl = cs.every((c) => c.request_url_bruta_tem_valor);
  const comp = cs[0]?.comparacao || {};
  const testeBrowserOk = cs.some((c) => c.teste_request_url_apex?.browser?.ok);
  const testeNodeOk = cs.some((c) => c.teste_request_url_apex?.node?.ok);
  const publicaBrowserOk = cs.some((c) => c.teste_url_publica?.browser?.ok);
  const ajaxTemItens = cs.some((c) =>
    (c.ajax_respostas || []).some((a) => (a.itens?.items || a.itens || []).length > 0)
  );

  const perguntas = {
    A_chama_endpoint_publico_remuneracoes:
      comp.mesmo_path === true && comp.path_apex?.includes('/remuneracoes'),
    B_url_diferente: comp.mesmo_path === false || (comp.parametros_so_apex?.length ?? 0) > 0,
    C_tem_token_ou_param_extra:
      (comp.parametros_so_apex?.length ?? 0) > 0 ||
      cs.some((c) =>
        Object.keys(c.request_url?.parametros || {}).some((k) =>
          /token|session|auth|p_request|salt/i.test(k)
        )
      ),
    D_url_apenas_informativa:
      temUrl && !testeBrowserOk && !testeNodeOk && cs.every((c) => (c.resultado?.quantidade ?? 0) > 0),
    E_reproduzivel_sem_clique: testeBrowserOk || testeNodeOk
  };

  let arquitetura_recomendada = 'indefinida';
  if (perguntas.E_reproduzivel_sem_clique && testeBrowserOk) {
    arquitetura_recomendada = 'http_browser_fetch_com_url_apex';
  } else if (perguntas.D_url_apenas_informativa || (!testeBrowserOk && !testeNodeOk && !publicaBrowserOk)) {
    arquitetura_recomendada = 'apex_pagina_reutilizada';
  } else if (perguntas.A_chama_endpoint_publico_remuneracoes && !testeBrowserOk) {
    arquitetura_recomendada = 'apex_server_side_plsql';
  }

  return {
    perguntas,
    tem_request_url: temUrl,
    request_url_reutilizavel_browser: testeBrowserOk,
    request_url_reutilizavel_node: testeNodeOk,
    url_publica_funciona_browser: publicaBrowserOk,
    ajax_retorna_itens: ajaxTemItens,
    tempo_medio_apex_ms: Math.round(
      cs.reduce((s, c) => s + (c.tempo_apex_ms || 0), 0) / cs.length
    ),
    abandonar_http_direto: !testeBrowserOk && !testeNodeOk,
    arquitetura_recomendada
  };
}

export async function executarInvestigacaoRequestUrlEFechar(opts) {
  try {
    return await executarInvestigacaoRequestUrl(opts);
  } finally {
    await closeBrowser().catch(() => {});
  }
}
