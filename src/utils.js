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
 * (DA/DE/DOS) e depois primeiro+último sobrenome.
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
  if (semPart.length >= 3) {
    add(`${semPart[0]} ${semPart[semPart.length - 1]}`);
  }

  return out;
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
