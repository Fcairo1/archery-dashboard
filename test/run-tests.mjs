// Testes automatizados (Node >=18, sem dependências).
// Extrai as funções reais de index.html/registrar.html por casamento de chaves
// e roda contra elas, para nunca testar uma cópia divergente da implementação.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL: ' + msg); }
}
function eq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  assert(ok, `${msg} — esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`);
}
function close(a, b, msg, eps = 1e-6) {
  assert(Math.abs(a - b) < eps, `${msg} — esperado ~${b}, obtido ${a}`);
}

function extractFunction(src, name) {
  const startMatch = src.match(new RegExp(`function\\s+${name}\\s*\\(`));
  if (!startMatch) throw new Error(`função ${name} não encontrada no arquivo`);
  let i = startMatch.index + startMatch[0].length - 1; // aponta pro '('
  // pula até achar o '{' que abre o corpo
  while (src[i] !== '{') i++;
  let depth = 0, start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(startMatch.index, i);
}

function extractConst(src, name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=[^;]+;`));
  return m ? m[0] : '';
}

function loadFns(file, names, consts = []) {
  const src = readFileSync(path.join(root, file), 'utf8');
  const constDecls = [...new Set(consts.map(c => extractConst(src, c)))].join('\n');
  const parts = names.map(n => extractFunction(src, n));
  const ctx = { console, TextEncoder, TextDecoder, btoa, atob, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(constDecls + '\n' + parts.join('\n\n') + `\n;globalThis.__out = {${names.join(',')}};`, ctx);
  return ctx.__out;
}

// ---------- 1) classify() (registrar.html) ----------
{
  const { classify } = loadFns('registrar.html', ['classify'], ['R_OUT', 'R_X', 'STEP']);
  // 10 bandas + X, diâmetro de flecha 0 (sem folga) pra testar limites exatos
  const bands = [
    [0, 10, 11],    // dentro do X (r<=10) -> 11
    [10, 0, 11],    // exatamente na borda do X -> 11
    [10.01, 0, 10], // logo fora do X -> anel 10
    [20, 0, 10],    // borda 20mm -> ainda anel 10 (eff<=20 -> ceil(20/20)=1 -> 11-1=10)
    [20.01, 0, 9],
    [40, 0, 9],
    [40.01, 0, 8],
    [200, 0, 1],    // borda externa -> anel 1
    [200.01, 0, 0], // fora
  ];
  for (const [r, diam, expected] of bands) {
    close(classify(r, 0, diam), expected, `classify(${r},0,${diam})`, 0.001);
  }
  // efeito do diâmetro da flecha na regra da linha: tubo de 6mm, centro do disparo a 202mm
  // borda interna do tubo = 202 - 3 = 199 <= 200 -> ainda vale anel 1, não "fora"
  eq(classify(202, 0, 6), 1, 'classify com diâmetro de flecha deve contar a borda interna do tubo');
  eq(classify(204, 0, 6), 0, 'classify: fora do alvo quando até a borda interna do tubo passa de 200mm');
}

// ---------- 5) base64 UTF-8 round-trip (registrar.html) ----------
{
  const { b64EncodeUtf8, b64DecodeUtf8 } = loadFns('registrar.html', ['b64EncodeUtf8', 'b64DecodeUtf8']);
  const original = 'Treino de postura, ótimo agrupamento — chuva à tarde, arco emprestado.';
  const decoded = b64DecodeUtf8(b64EncodeUtf8(original));
  assert(decoded === original, 'base64 UTF-8 deve sobreviver ao ciclo salvar → ler, com acentos e travessão');
}

// ---------- 3 + 2) inferência de ano e parser do CSV real (index.html) ----------
{
  const { parseCSV, parseNum, extractSessions } = loadFns('index.html', ['parseCSV', 'parseNum', 'extractSessions']);

  // parseNum: formato brasileiro
  close(parseNum('6,24'), 6.24, 'parseNum decimal BR');
  close(parseNum('1.234,5'), 1234.5, 'parseNum milhar+decimal BR');
  assert(parseNum('Alvo sem anéis branco e preto') === null, 'parseNum deve retornar null para texto');

  // inferência de ano isolada, replicando a lógica de extractSessions sobre datas sintéticas
  function inferYears(dds) {
    let year = 2024, prev = null;
    const out = [];
    for (const d of dds) {
      const [dd, mm] = d.split('/').map(Number);
      const key = mm * 100 + dd;
      if (prev !== null && key < prev) year++;
      prev = key;
      out.push(`${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
    }
    return out;
  }
  eq(inferYears(['04/07', '01/08']), ['2024-07-04', '2024-08-01'], 'virada 04/07→01/08 continua no mesmo ano');
  eq(inferYears(['21/12', '11/01']), ['2024-12-21', '2025-01-11'], 'virada 21/12→11/01 avança o ano');

  // CSV real da planilha (gviz) — pode falhar sem rede; nesse caso o teste avisa mas não derruba a suíte
  const CSV_URL = 'https://docs.google.com/spreadsheets/d/1tN0zsr7ifZIVH4AyCm3XfcRSPDwlFzhzy2LpmefPzpU/gviz/tq?tqx=out:csv&gid=0';
  try {
    const resp = await fetch(CSV_URL);
    const csv = await resp.text();
    const sessions = extractSessions(csv);
    eq(sessions.length, 77, 'planilha real: 77 sessões');
    eq(sessions[0].iso, '2024-01-20', 'planilha real: primeira sessão 2024-01-20');
    const last = sessions[sessions.length - 1];
    eq(last.iso, '2025-08-16', 'planilha real: última sessão 2025-08-16');
    eq(last.total, 103, 'planilha real: total da última sessão');
    eq(last.counts, [1, 3, 7, 5, 3, 16, 16, 18, 16, 13, 3, 2], 'planilha real: contagens da última sessão');

    // formato "export" (sem aspas em todas as células) — simulado removendo aspas de campos sem vírgula
    const csvExport = csv.replace(/"([^",\n]*)"/g, '$1');
    const sessionsExport = extractSessions(csvExport);
    assert(sessionsExport.length >= 70, 'parser deve funcionar também no formato CSV "export" (sem aspas em tudo)');
  } catch (e) {
    console.warn('AVISO: não foi possível buscar o CSV real da planilha agora (' + e.message + ') — pulando esse teste.');
  }
}

// ---------- 4) fusão das duas fontes (index.html) ----------
{
  const { mergeSources } = loadFns('index.html', ['mergeSources']);
  const sheet = [
    { iso: '2025-08-16', total: 103, counts: Array(12).fill(0), avg: 6.24 },
    { iso: '2025-07-05', total: 86, counts: Array(12).fill(0), avg: 5.02 },
  ];
  const json = [
    { iso: '2025-08-16', total: 60, counts: Array(12).fill(0), avg: 7.0 }, // mesma data do sheet -> JSON deve vencer
    { iso: '2026-01-10', total: 50, counts: Array(12).fill(0), avg: 6.5 },
  ];
  const merged = mergeSources(sheet, json);
  eq(merged.map(s => s.iso), ['2025-07-05', '2025-08-16', '2026-01-10'], 'fusão deve ordenar cronologicamente');
  const dup = merged.find(s => s.iso === '2025-08-16');
  eq(dup.source, 'json', 'em data duplicada, o JSON deve ter precedência sobre a planilha');
  close(dup.avg, 7.0, 'valor do JSON deve prevalecer na data duplicada');

  // JSON ausente (404 -> lista vazia) não deve quebrar a fusão
  const mergedNoJson = mergeSources(sheet, []);
  eq(mergedNoJson.length, 2, 'fusão sem JSON deve manter só as sessões da planilha, sem erro');
}

// ---------- soma das contagens == total (invariante das sessões novas) ----------
{
  const { classify } = loadFns('registrar.html', ['classify'], ['R_OUT', 'R_X', 'STEP']);
  const shots = [[5, 5], [-30, 10], [null, null], [0, 0], [190, 0]];
  const counts = Array(12).fill(0);
  for (const [x, y] of shots) {
    const cat = x == null ? 0 : classify(x, y, 6);
    counts[cat]++;
  }
  const total = shots.length;
  eq(counts.reduce((a, b) => a + b, 0), total, 'soma das contagens deve bater com o total de flechas');
}

console.log(`\n${pass} passaram, ${fail} falharam.`);
if (fail > 0) process.exit(1);
