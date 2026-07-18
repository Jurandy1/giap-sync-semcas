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

/**
 * Nome para busca no GIAP — nome completo normalizado.
 * O portal (Dados Abertos) aceita nome completo em nome_servidor, ex.:
 * JURANDY SOARES SANTANA JUNIOR → acha o registro certo.
 */
export function nomeBuscaGiap(nome) {
  const tokens = tokensNome(nome);
  if (!tokens.length) return null;
  return tokens.join(' ');
}

/**
 * Variantes de busca: nome completo primeiro; se falhar, tenta sem partículas
 * (DA/DE/DOS), depois com tokens curtos fundidos ("CONCEI CAO" → "CONCEICAO"),
 * depois primeiro+último sobrenome.
 */
export function variantesBuscaGiap(nome) {
  const tokens = tokensNome(nome);
  if (!tokens.length) return [];

  const particulas = new Set(['DA', 'DE', 'DO', 'DAS', 'DOS', 'E', 'DI', 'DU']);
  const out = [];
  const add = (s) => {
    const v = String(s || '').trim();
    if (v && !out.includes(v)) out.push(v);
  };

  add(tokens.join(' '));

  const semPart = tokens.filter((t) => !particulas.has(t));
  if (semPart.length >= 2 && semPart.join(' ') !== tokens.join(' ')) {
    add(semPart.join(' '));
  }

  // Funde tokens curtos (<=3 chars, exceto partículas) com o anterior:
  // "CONCEI CAO" → "CONCEICAO". Cobre fragmentação por erro de digitação.
  const fundido = [];
  for (const t of tokens) {
    if (
      t.length <= 3 &&
      !particulas.has(t) &&
      fundido.length > 0
    ) {
      fundido[fundido.length - 1] += t;
    } else {
      fundido.push(t);
    }
  }
  // Portal parece exigir partículas na string de busca — mantém "DO" e cia.
  if (fundido.join(' ') !== tokens.join(' ')) {
    add(fundido.join(' '));
  }
  const fundidoSemPart = fundido.filter((t) => !particulas.has(t));
  if (fundidoSemPart.length >= 2) {
    add(fundidoSemPart.join(' '));
  }

  // Primeiro + último sobrenome — ignora sufixos como JR/JUNIOR/FILHO/NETO.
  const semSufixos = semPart.filter((t) => !SUFIXOS_IGNORADOS.has(t));
  const alvoPU = semSufixos.length >= 2 ? semSufixos : semPart;
  if (alvoPU.length >= 3) {
    add(`${alvoPU[0]} ${alvoPU[alvoPU.length - 1]}`);
  } else if (alvoPU.length === 2 && semPart.length >= 3) {
    // Só emite se a versão com sufixos era mais longa (senão duplica variante 0)
    add(`${alvoPU[0]} ${alvoPU[1]}`);
  }

  // Último recurso: token mais raro sozinho. A busca do GIAP é substring
  // (não só prefixo), então "THAYLLANNA" acha a servidora mesmo com o
  // sobrenome abreviado/errado no RH. O filtro de similaridade pós-scrape
  // segura os homônimos.
  const raros = fundido.filter(
    (t) =>
      !particulas.has(t) &&
      !SUFIXOS_IGNORADOS.has(t) &&
      !NOMES_COMUNS.has(t) &&
      t.length >= 5
  );
  if (raros.length) {
    add(raros.reduce((a, b) => (b.length > a.length ? b : a)));
  }

  return out;
}

/** Nomes/sobrenomes frequentes demais pra busca de token único. */
const NOMES_COMUNS = new Set([
  'MARIA', 'JOSE', 'JOAO', 'ANTONIO', 'ANTONIA', 'FRANCISCO', 'FRANCISCA',
  'CARLOS', 'PAULO', 'PEDRO', 'LUCAS', 'MARCOS', 'RAIMUNDO', 'RAIMUNDA',
  'MANOEL', 'MANUEL', 'FATIMA', 'LOURDES', 'CONCEICAO', 'APARECIDA',
  'SILVA', 'SANTOS', 'SOUSA', 'SOUZA', 'OLIVEIRA', 'LIMA', 'COSTA',
  'PEREIRA', 'FERREIRA', 'RODRIGUES', 'ALMEIDA', 'NASCIMENTO', 'ARAUJO',
  'RIBEIRO', 'CARVALHO', 'GOMES', 'MARTINS', 'BARBOSA', 'ALVES', 'MORAES',
  'MORAIS', 'CASTRO', 'ANDRADE', 'MENDES', 'FREITAS', 'CARDOSO', 'RAMOS',
  'GONCALVES', 'DIAS', 'MOREIRA', 'NUNES', 'MARQUES', 'MACHADO', 'VIEIRA'
]);

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
