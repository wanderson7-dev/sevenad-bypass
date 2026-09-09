// Análise "anti-transcript inteligente":
//  1) transcreve o áudio com timestamps por palavra (AssemblyAI)
//  2) manda a transcrição pro Claude API achar as palavras sensíveis
//  3) devolve os intervalos de tempo (start/end) dessas palavras
//
// A transcrição roda na AssemblyAI (fora do servidor) — leve de RAM, ideal pro Railway.

const fs = require('fs');

const AAI_BASE = 'https://api.assemblyai.com/v2';
// Idioma da fala. 'auto' -> deixa a AssemblyAI detectar; senão usa language_code (ex: 'en', 'pt').
const AAI_LANG = process.env.ASSEMBLYAI_LANG || 'en';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transcreve um arquivo de áudio -> { text, words:[{text,start,end}] } (start/end em SEGUNDOS).
async function transcribeWords(audioPath) {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error('ASSEMBLYAI_API_KEY não configurada');

  // 1) upload do áudio
  const bytes = fs.readFileSync(audioPath);
  const up = await fetch(`${AAI_BASE}/upload`, {
    method: 'POST',
    headers: { authorization: key },
    body: bytes,
  });
  if (!up.ok) throw new Error(`AssemblyAI upload falhou (${up.status})`);
  const { upload_url } = await up.json();

  // 2) cria o job de transcrição
  const params = { audio_url: upload_url, punctuate: true, format_text: true };
  if (AAI_LANG === 'auto') params.language_detection = true;
  else params.language_code = AAI_LANG;

  const create = await fetch(`${AAI_BASE}/transcript`, {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!create.ok) throw new Error(`AssemblyAI create falhou (${create.status})`);
  const { id } = await create.json();

  // 3) faz polling até concluir (máx ~5 min)
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const g = await fetch(`${AAI_BASE}/transcript/${id}`, { headers: { authorization: key } });
    const t = await g.json();
    if (t.status === 'completed') {
      const words = (t.words || []).map((w) => ({
        text: w.text,
        start: w.start / 1000,
        end: w.end / 1000,
      }));
      return { text: t.text || '', words };
    }
    if (t.status === 'error') throw new Error(`AssemblyAI error: ${t.error}`);
  }
  throw new Error('AssemblyAI: timeout na transcrição');
}

// Extrai o primeiro bloco JSON de um texto (tolerante a texto ao redor).
function extractJson(s) {
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch {}
  }
  return null;
}

// Pergunta ao Claude quais índices de palavras são sensíveis (podem reprovar o anúncio).
async function findSensitiveIndices(words) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY não configurada');
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente

  const numbered = words.map((w, i) => `${i}: ${w.text}`).join('\n');
  const fullText = words.map((w) => w.text).join(' ');

  const system =
    'Você analisa a transcrição de um anúncio (VSL/criativo) e identifica quais PALAVRAS ' +
    'podem fazer o anúncio ser reprovado ou bloqueado pelas plataformas de anúncio ' +
    '(Meta/Facebook, Google, TikTok). São sensíveis, por exemplo: promessas de cura ou ' +
    'tratamento de doenças, nomes de doenças/condições médicas, garantias de resultado, ' +
    'promessas de ganho financeiro/renda garantida ou fácil, uso de marcas de terceiros ' +
    'implicando afiliação, emagrecimento milagroso, alegações exageradas, linguagem ' +
    'manipulativa/de medo, palavrões e linguagem proibida. Seja preciso: marque também ' +
    'TODAS as palavras que compõem uma expressão sensível (não só uma). ' +
    'Responda SOMENTE com JSON no formato {"indices":[<inteiros>]} com os índices das ' +
    'palavras sensíveis. Se nada for sensível, responda {"indices":[]}.';

  const user =
    `Transcrição completa:\n"${fullText}"\n\n` +
    `Palavras numeradas (índice: palavra):\n${numbered}\n\n` +
    `Retorne apenas o JSON com os índices sensíveis.`;

  const resp = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 2048,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: user }],
  });

  const textBlock = (resp.content || []).find((b) => b.type === 'text');
  const raw = textBlock ? textBlock.text : '';
  const parsed = extractJson(raw) || {};
  const indices = Array.isArray(parsed.indices) ? parsed.indices : [];
  return indices
    .map((n) => parseInt(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < words.length);
}

// Converte índices sensíveis em intervalos de tempo mesclados, com um respiro (padding).
function indicesToRanges(words, indices, padding = 0.08) {
  const set = new Set(indices);
  const raw = [];
  for (let i = 0; i < words.length; i++) {
    if (set.has(i)) {
      raw.push([Math.max(0, words[i].start - padding), words[i].end + padding]);
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of raw) {
    if (merged.length && s <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

// Fluxo completo: áudio -> palavras -> índices sensíveis -> intervalos.
async function analyzeSensitiveRanges(audioPath) {
  const { text, words } = await transcribeWords(audioPath);
  if (!words.length) return { text, words: [], sensitive: [], ranges: [] };
  const indices = await findSensitiveIndices(words);
  const ranges = indicesToRanges(words, indices);
  const sensitive = indices.map((i) => words[i].text);
  return { text, words, sensitive, ranges };
}

module.exports = { analyzeSensitiveRanges, transcribeWords, findSensitiveIndices, indicesToRanges };
