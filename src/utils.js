/**
 * Normaliza CPF removendo qualquer coisa não-numérica e padding com zero à esquerda.
 * O GIAP retorna CPF como número, então CPFs que começam com 0 perdem o dígito.
 * padStart(11, '0') recupera isso.
 */
export function normalizarCPF(cpf) {
  if (cpf === null || cpf === undefined || cpf === '') return null;
  const digits = String(cpf).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length > 11) return null; // CPF válido tem <=11 dígitos
  return digits.padStart(11, '0');
}

/**
 * Normaliza nome pra comparação:
 * - Remove acentos (NFD + strip combining marks)
 * - UPPERCASE
 * - Remove caracteres não-alfanuméricos exceto espaço
 * - Colapsa múltiplos espaços
 */
export function normalizarNome(nome) {
  if (!nome) return null;
  return String(nome)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens do nome (palavras), já normalizados. */
export function tokensNome(nome) {
  const n = normalizarNome(nome);
  if (!n) return [];
  return n.split(' ').filter(Boolean);
}

/**
 * Sufixos/partículas descartados na comparação permissiva:
 * `JR` vs `JUNIOR`, sobrenomes duplicados, preposições.
 */
export const SUFIXOS_IGNORADOS = new Set([
  'JR', 'JUNIOR', 'FILHO', 'NETO', 'SOBRINHO',
  'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'DI', 'DU'
]);

/**
 * Casamento permissivo: verdadeiro se
 * (1) os nomes concatenados sem espaço batem exato — captura tokens
 *     fragmentados no cadastro RH ("CONCEI CAO" vs "CONCEICAO") — OU
 * (2) todos os tokens não-triviais de A aparecem em B (ou vice-versa),
 *     ignorando `SUFIXOS_IGNORADOS` — captura `JR` vs `JUNIOR`.
 */
export function nomeCasaPermissivo(a, b) {
  const na = normalizarNome(a);
  const nb = normalizarNome(b);
  if (!na || !nb) return false;
  const semA = na.replace(/\s+/g, '');
  const semB = nb.replace(/\s+/g, '');
  if (semA && semA === semB) return true;

  const ta = tokensNome(a).filter((t) => !SUFIXOS_IGNORADOS.has(t));
  const tb = tokensNome(b).filter((t) => !SUFIXOS_IGNORADOS.has(t));
  if (!ta.length || !tb.length) return false;
  const setA = new Set(ta);
  const setB = new Set(tb);
  const aInB = ta.every((t) => setB.has(t));
  const bInA = tb.every((t) => setA.has(t));
  return aInB || bInA;
}

/**
 * Similaridade de nomes (0–1) por tokens em comum.
 * Exige que o menor nome tenha quase todos os tokens no maior
 * (evita casar "JOAO" com "JOAO PEDRO SILVA" sem mais evidência).
 */
export function similaridadeNome(a, b) {
  const ta = tokensNome(a);
  const tb = tokensNome(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const comuns = ta.filter((t) => setB.has(t)).length;
  const menor = Math.min(ta.length, tb.length);
  const maior = Math.max(ta.length, tb.length);
  if (menor === 0) return 0;
  // Cobertura do menor + leve peso do tamanho
  const cobertura = comuns / menor;
  const tamanho = menor / maior;
  return cobertura * 0.85 + tamanho * 0.15;
}

const PARTICULAS_NOME = new Set(['DA', 'DE', 'DO', 'DAS', 'DOS', 'E', 'DI', 'DU']);

/** Funde pedaços quebrados no RH: "CONCEI CAO" / "Concei Ção" → CONCEICAO */
export function fundirTokensCurtos(tokens) {
  const out = [];
  for (const t of tokens) {
    // Conceição partido no cadastro: "CONCEI" + "CAO"
    if (out.length > 0 && out[out.length - 1] === 'CONCEI' && t === 'CAO') {
      out[out.length - 1] = 'CONCEICAO';
      continue;
    }
    if (t.length <= 3 && !PARTICULAS_NOME.has(t) && out.length > 0) {
      out[out.length - 1] += t;
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * Nome completo normalizado (com fusão de tokens curtos).
 * Ex.: JURANDY SOARES SANTANA JUNIOR — como no Portal Dados Abertos.
 */
export function nomeBuscaGiap(nome) {
  const tokens = fundirTokensCurtos(tokensNome(nome));
  if (!tokens.length) return null;
  return tokens.join(' ');
}

/**
 * Variantes p/ sem matrícula: nome completo → encurta pelo fim (prefixo GIAP).
 * Nunca usa 1 token só (evita ARIADNA/AROUCHE com homônimos).
 * Máx. 5 scrapes por pessoa.
 */
export function variantesBuscaSemMatricula(nome) {
  const tokens = fundirTokensCurtos(tokensNome(nome));
  if (tokens.length < 2) return tokens.length ? [tokens[0]] : [];

  const out = [];
  const add = (arr) => {
    if (!arr?.length) return;
    const significativos = arr.filter((t) => !PARTICULAS_NOME.has(t));
    if (significativos.length < 2) return;
    const s = arr.join(' ');
    if (!out.includes(s)) out.push(s);
  };

  // Completo → vai removendo o último token (LIKE prefixo no portal)
  for (let n = tokens.length; n >= 2 && out.length < 5; n--) {
    add(tokens.slice(0, n));
  }

  // Sem partículas (RH tem "DA/DE", GIAP às vezes não)
  const semPart = tokens.filter((t) => !PARTICULAS_NOME.has(t));
  if (semPart.length >= 2) {
    for (let n = semPart.length; n >= 2 && out.length < 5; n--) {
      add(semPart.slice(0, n));
    }
  }

  return out.slice(0, 5);
}

/**
 * Variantes gerais (quem já tem matrícula / completar folha).
 */
export function variantesBuscaGiap(nome) {
  return variantesBuscaSemMatricula(nome);
}

/**
 * Converte data do GIAP (DD-MM-YYYY, DD/MM/YYYY ou ISO) pra YYYY-MM-DD.
 */
export function parseDataBR(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/**
 * Retorna a competência YYYYMM "segura" — mês anterior ao atual.
 * A folha do mês corrente costuma ficar disponível só no fim do mês.
 */
export function competenciaAtual() {
  const d = new Date();
  const ano = d.getFullYear();
  const mes = d.getMonth(); // 0-indexed, então getMonth() = mês anterior
  if (mes === 0) return (ano - 1) * 100 + 12;
  return ano * 100 + mes;
}

/**
 * Valida formato de competência (YYYYMM).
 */
export function validarCompetencia(c) {
  const n = Number(c);
  if (!Number.isInteger(n)) return false;
  const ano = Math.floor(n / 100);
  const mes = n % 100;
  return ano >= 2000 && ano <= 2100 && mes >= 1 && mes <= 12;
}
