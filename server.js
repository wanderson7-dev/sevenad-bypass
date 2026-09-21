// Carrega variáveis de um arquivo .env local (NÃO versionado). No Railway,
// as variáveis vêm do painel — este bloco simplesmente não faz nada lá.
(() => {
  try {
    const fsx = require('fs'), px = require('path');
    const envPath = px.join(__dirname, '.env');
    if (!fsx.existsSync(envPath)) return;
    for (const line of fsx.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m || (m[1] in process.env)) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch {}
})();

const express = require('express');
const multer = require('multer');
const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
const { analyzeSensitiveRanges } = require('./smart');
// Usa ffmpeg do sistema (Docker/Railway) se disponível, senão usa ffmpeg-static (local)
let ffmpegPath;
try {
  ffmpegPath = execSync('which ffmpeg').toString().trim();
} catch {
  ffmpegPath = require('ffmpeg-static');
}
// ffprobe (para descobrir a resolução do vídeo no filtro Halftone)
let ffprobePath = null;
try {
  ffprobePath = execSync('which ffprobe').toString().trim();
} catch {
  ffprobePath = null;
}

const app = express();
const upload = multer({ dest: '/tmp' });

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  try {
    const result = spawnSync(ffmpegPath, ['-version'], { timeout: 5000 });
    res.json({
      ffmpegPath,
      ok: result.status === 0,
      version: result.stdout?.toString().split('\n')[0] || '',
      error: result.stderr?.toString().split('\n')[0] || '',
      spawnError: result.error?.message || null,
    });
  } catch (e) {
    res.status(500).json({ ffmpegPath, ok: false, error: e.message });
  }
});

function parseBool(val) {
  return val === 'true' || val === true;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Executa o FFmpeg de forma assíncrona e relata o progresso através do tempo
// processado. Retorna uma Promise com { status, signal, err }.
//  - durationSec: duração do vídeo (para calcular a fração 0..1). Se ausente,
//    não há relato de progresso (só o "pulo" ao concluir).
//  - onProgress(frac): chamado com a fração (0..1) do passe atual.
function runFfmpeg(args, opts = {}) {
  const { durationSec, onProgress, timeout = 600000 } = opts;
  return new Promise((resolve) => {
    // Injeta -nostats -progress pipe:1 (logo após o -y global, se houver).
    const full = args.slice();
    const insertAt = full[0] === '-y' ? 1 : 0;
    full.splice(insertAt, 0, '-nostats', '-progress', 'pipe:1');

    let child;
    try {
      child = spawn(ffmpegPath, full);
    } catch (e) {
      return resolve({ status: null, signal: null, err: e.message });
    }

    let errTail = '';
    let outBuf = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch {} }, timeout);

    child.stdout.on('data', (d) => {
      outBuf += d.toString();
      let idx;
      while ((idx = outBuf.indexOf('\n')) >= 0) {
        const line = outBuf.slice(0, idx);
        outBuf = outBuf.slice(idx + 1);
        if (!onProgress || !durationSec) continue;
        let us = null;
        let m = line.match(/^out_time_us=(\d+)/);
        if (m) us = Number(m[1]);
        else if ((m = line.match(/^out_time_ms=(\d+)/))) us = Number(m[1]) * 1000;
        if (us != null) {
          let f = us / 1e6 / durationSec;
          if (!isFinite(f) || f < 0) f = 0;
          if (f > 0.999) f = 0.999;
          onProgress(f);
        }
      }
    });
    child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-4000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: null, signal: null, err: e.message }); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (onProgress && durationSec) onProgress(0.999);
      resolve({
        status,
        signal: killed ? 'SIGKILL(timeout)' : signal,
        err: errTail.slice(-300),
      });
    });
  });
}

// Descobre a duração (em segundos) de um mídia. Tenta ffprobe; se indisponível,
// faz o parse do stderr do `ffmpeg -i` (sempre funciona, inclusive com ffmpeg-static).
function getDurationSec(input) {
  return new Promise((resolve) => {
    if (ffprobePath) {
      try {
        const r = spawnSync(ffprobePath, [
          '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input,
        ], { timeout: 15000 });
        const d = parseFloat((r.stdout?.toString() || '').trim());
        if (d > 0) return resolve(d);
      } catch {}
    }
    // Fallback: parse do "Duration: HH:MM:SS.xx" no stderr do ffmpeg.
    try {
      const child = spawn(ffmpegPath, ['-i', input]);
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', () => resolve(null));
      child.on('close', () => {
        const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) return resolve((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]));
        resolve(null);
      });
    } catch { resolve(null); }
  });
}

// Extrai o áudio de um arquivo (vídeo ou áudio) para um arquivo .wav temporário
async function extractAudio(inputPath, outputPath) {
  const r = await runFfmpeg([
    '-y', '-i', inputPath,
    '-vn', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    outputPath,
  ], { timeout: 120000 });
  return r.status === 0;
}

// Anexa uma imagem (do usuário) no início e/ou no fim do vídeo.
// position: 'start' | 'end' | 'both'. startDur/endDur em segundos.
// A imagem é escalada para casar com a resolução do vídeo (scale com input de
// referência: rw/rh) e áudio silencioso (anullsrc) preenche os trechos adicionados.
async function addImageBumper(inputPath, imagePath, position, startDur, endDur, outputPath, isGif, opts = {}) {
  const wantStart = position === 'start' || position === 'both';
  const wantEnd   = position === 'end'   || position === 'both';

  // GIF animado: -ignore_loop 0 repete o gif; imagem estática: -loop 1 congela o frame.
  const imgInput = (dur) => isGif
    ? ['-ignore_loop', '0', '-t', String(dur), '-i', imagePath]
    : ['-loop', '1', '-t', String(dur), '-i', imagePath];

  // Monta inputs dinamicamente e guarda os índices de cada um
  const args = ['-y', '-i', inputPath];
  let idx = 1;
  let startImgIdx, endImgIdx, startSilIdx, endSilIdx;
  if (wantStart) { args.push(...imgInput(startDur)); startImgIdx = idx++; }
  if (wantEnd)   { args.push(...imgInput(endDur));   endImgIdx = idx++; }
  if (wantStart) { args.push('-f', 'lavfi', '-t', String(startDur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'); startSilIdx = idx++; }
  if (wantEnd)   { args.push('-f', 'lavfi', '-t', String(endDur),   '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'); endSilIdx = idx++; }

  const f = [];
  // Vídeo/áudio principal normalizados
  f.push(`[0:v]fps=30,setsar=1,format=yuv420p[mv]`);
  f.push(`[0:a]aformat=sample_rates=48000:channel_layouts=stereo[ma]`);

  const order = []; // sequência final [video, audio] para o concat
  if (wantStart) {
    f.push(`[${startImgIdx}:v][0:v]scale=rw:rh[imgs]`);
    f.push(`[imgs]fps=30,setsar=1,format=yuv420p[sv]`);
    f.push(`[${startSilIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo[sa]`);
    order.push(['sv', 'sa']);
  }
  order.push(['mv', 'ma']);
  if (wantEnd) {
    f.push(`[${endImgIdx}:v][0:v]scale=rw:rh[imge]`);
    f.push(`[imge]fps=30,setsar=1,format=yuv420p[ev]`);
    f.push(`[${endSilIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo[ea]`);
    order.push(['ev', 'ea']);
  }

  const n = order.length;
  const concatIn = order.map(([v, a]) => `[${v}][${a}]`).join('');
  f.push(`${concatIn}concat=n=${n}:v=1:a=1[outv][outa]`);

  args.push(
    '-filter_complex', f.join(';'),
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-threads', '1', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k',
    outputPath,
  );

  console.log(`FFmpeg bumper cmd: ${ffmpegPath} ${args.join(' ')}`);
  const result = await runFfmpeg(args, {
    durationSec: opts.durationSec ? opts.durationSec + startDur + endDur : undefined,
    onProgress: opts.onProgress,
  });
  const ok = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
  if (!ok && result.err) console.log('Bumper stderr (last 300):', result.err);
  return { ok, err: result.err || '', status: result.status, signal: result.signal };
}

// Descobre a resolução (largura/altura) de um vídeo via ffprobe.
function probeSize(file) {
  if (!ffprobePath) return null;
  try {
    const r = spawnSync(ffprobePath, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file
    ], { timeout: 15000 });
    const out = (r.stdout?.toString() || '').trim(); // ex: "720,1280"
    const [w, h] = out.split(',').map((n) => parseInt(n));
    if (w > 0 && h > 0) return { w, h };
  } catch {}
  return null;
}

// Halftone (rápido): gera uma trama de pontos no tamanho EXATO do vídeo e a
// sobrepõe via multiply. Muito mais rápido que geq por frame. A opacidade
// controla a força dos pontos (5% = bem sutil, 100% = pontos pretos fortes).
// A cor do vídeo é preservada (multiply por textura neutra).
async function applyHalftoneOverlay(inputPath, opacity, outputPath, tmpPrefix, opts = {}) {
  const size = probeSize(inputPath);
  if (!size) return { ok: false, err: 'ffprobe indisponível ou falhou ao ler a resolução' };
  const { w, h } = size;

  // Textura de pontos redondos (anti-aliased) branca com pontos pretos, grade de 6px.
  const texPath = `${tmpPrefix}_httex.png`;
  const S = 6, hc = 3, r = 2.0;
  const tgen = await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', `color=c=white:s=${w}x${h}`, '-frames:v', '1',
    '-vf', `format=gray,geq=lum='255*clip(hypot(mod(X\\,${S})-${hc}\\,mod(Y\\,${S})-${hc})-${r}+0.5\\,0\\,1)'`,
    texPath
  ], { timeout: 60000 });
  if (!fs.existsSync(texPath)) {
    return { ok: false, err: 'falha ao gerar textura: ' + (tgen.err || '') };
  }

  const op = (opacity / 100).toFixed(3);
  const args = [
    '-y', '-i', inputPath, '-i', texPath,
    '-filter_complex',
    `[0:v]format=gbrp[b];[1:v]format=gbrp[t];[b][t]blend=all_mode=multiply:all_opacity=${op},format=yuv420p[o]`,
    '-map', '[o]', '-map', '0:a?', '-c:a', 'copy',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-threads', '1', '-r', '30',
    outputPath
  ];
  console.log(`FFmpeg halftone cmd: ${ffmpegPath} ${args.join(' ')}`);
  const result = await runFfmpeg(args, { durationSec: opts.durationSec, onProgress: opts.onProgress });
  try { fs.unlinkSync(texPath); } catch {}
  const ok = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
  if (!ok && result.err) console.log('Halftone stderr (last 300):', result.err);
  return { ok, err: result.err || '', status: result.status, signal: result.signal };
}

// Extrai o áudio como um m4a mono 16kHz compacto (pra enviar à AssemblyAI).
async function extractAudioForStt(inputPath, outPath, opts = {}) {
  const r = await runFfmpeg([
    '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', outPath
  ], { timeout: 180000, durationSec: opts.durationSec, onProgress: opts.onProgress });
  return r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
}

// Anti-transcript SELETIVO: inverte a fase do canal direito só nos intervalos
// (palavras sensíveis). Assim o downmix mono da IA cancela só nesses trechos,
// enquanto o humano ouve tudo normalmente. Vídeo é copiado (sem re-encode).
async function applySmartAntiTranscribe(inputPath, ranges, outputPath, opts = {}) {
  const enable = ranges
    .map(([s, e]) => `between(t,${s.toFixed(3)},${e.toFixed(3)})`)
    .join('+');
  const fc =
    `[0:a]aformat=channel_layouts=stereo,channelsplit=channel_layout=stereo[l][r];` +
    `[r]volume=volume=-1:enable='${enable}'[ri];` +
    `[l][ri]join=inputs=2:channel_layout=stereo[a]`;
  const args = [
    '-y', '-i', inputPath,
    '-filter_complex', fc,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    outputPath,
  ];
  console.log(`FFmpeg smart-anti cmd: ${ffmpegPath} ${args.join(' ')}`);
  const result = await runFfmpeg(args, { durationSec: opts.durationSec, onProgress: opts.onProgress });
  const ok = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
  if (!ok && result.err) console.log('Smart-anti stderr (last 300):', result.err);
  return { ok, err: result.err || '', status: result.status, signal: result.signal };
}

// Comprime o vídeo para caber num tamanho-alvo (bitrate calculado a partir da
// duração). Mira ~94% do limite e, se estourar, reencoda uma vez com alvo menor.
async function compressUnderSize(inputPath, durationSec, outputPath, limitBytes, opts = {}) {
  const audioKbps = 128;
  const attempt = async (targetBytes) => {
    const totalKbps = Math.floor((targetBytes * 8) / durationSec / 1000);
    let videoKbps = totalKbps - audioKbps;
    if (videoKbps < 100) videoKbps = 100;
    const bufKbps = videoKbps * 2;
    const r = await runFfmpeg([
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${bufKbps}k`,
      '-c:a', 'aac', '-b:a', `${audioKbps}k`,
      '-movflags', '+faststart',
      outputPath,
    ], { durationSec, onProgress: opts.onProgress });
    const ok = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
    return { ok, size: ok ? fs.statSync(outputPath).size : 0, err: r.err, status: r.status, signal: r.signal };
  };

  let res = await attempt(Math.floor(limitBytes * 0.94));
  // Se ainda estourou o limite, recalcula pelo excesso real e reencoda uma vez.
  if (res.ok && res.size > limitBytes) {
    const ratio = (limitBytes * 0.90) / res.size;
    try { fs.unlinkSync(outputPath); } catch {}
    res = await attempt(Math.floor(limitBytes * 0.94 * ratio));
  }
  return res;
}

// Limite de tamanho quando "Limitar a 99 MB" está ligado. 99.000.000 bytes fica
// seguro tanto para plataformas que contam 100 MB decimais (100.000.000) quanto
// para 100 MiB (104.857.600).
const SIZE_LIMIT_BYTES = 99 * 1000 * 1000;

// Lê os campos do formulário -> objeto de settings.
function parseSettings(body) {
  return {
    do_uniqueize:            parseBool(body.do_uniqueize),
    do_audio_antitranscribe: parseBool(body.do_audio_antitranscribe),
    randomize_resolution:    parseBool(body.randomize_resolution),
    randomize_volume:        parseBool(body.randomize_volume),
    randomize_gamma:         parseBool(body.randomize_gamma),
    randomize_saturation:    parseBool(body.randomize_saturation),
    randomize_brightness:    parseBool(body.randomize_brightness),
    do_hidden_audio:         parseBool(body.do_hidden_audio),
    hidden_audio_volume:     parseFloat(body.hidden_audio_volume) || 0.03,
    do_image_bumper:         parseBool(body.do_image_bumper),
    bumper_position:         ['start', 'end', 'both'].includes(body.bumper_position) ? body.bumper_position : 'both',
    bumper_end_seconds:      Math.min(180, Math.max(1, parseInt(body.bumper_end_seconds) || 3)),
    do_halftone:             parseBool(body.do_halftone),
    halftone_opacity:        Math.min(100, Math.max(5, parseInt(body.halftone_opacity) || 50)),
    do_capcut_noise:         parseBool(body.do_capcut_noise),
    capcut_noise_strength:   Math.min(100, Math.max(1, parseInt(body.capcut_noise_strength) || 15)),
    do_smart_antitranscribe: parseBool(body.do_smart_antitranscribe),
    do_compress_100mb:       parseBool(body.do_compress_100mb),
    output_format:           body.output_format === 'mov' ? 'mov' : 'mp4',
  };
}

// Núcleo do processamento de UM vídeo (uma ou mais cópias). Relata o progresso
// (0..100) via onProgress. Retorna { generatedFiles, smartWords, error }.
async function runPipeline({ settings, numCopies, inputFile, hiddenFile, bumperFile, onProgress }) {
  const bumperImagePath = (settings.do_image_bumper && bumperFile) ? bumperFile.path : null;
  const bumperIsGif = !!bumperFile && (
    /gif/i.test(bumperFile.mimetype || '') || /\.gif$/i.test(bumperFile.originalname || '')
  );

  const inputPath = inputFile.path;
  const originalName = inputFile.originalname || 'video.mp4';
  const ext = path.extname(originalName);
  const name = path.basename(originalName, ext);
  const outExt = settings.output_format === 'mov' ? '.mov' : '.mp4';
  const randPrefix = randInt(10000, 99999);

  // Duração (para o cálculo de progresso e da compressão).
  const durationSec = await getDurationSec(inputPath);

  // ---- Contabilidade de progresso: cada "unidade" ≈ um passe de duração cheia.
  const willSmart    = settings.do_smart_antitranscribe;
  const willHalftone = settings.do_halftone;
  const willBumper   = settings.do_image_bumper && bumperImagePath;
  const willCompress = settings.do_compress_100mb;
  let totalUnits =
    (willSmart ? 1 : 0) + // extração de áudio p/ STT (uma vez)
    numCopies * (1 + (willSmart ? 1 : 0) + (willHalftone ? 1 : 0) + (willBumper ? 1 : 0) + (willCompress ? 1 : 0));
  if (totalUnits < 1) totalUnits = 1;
  let completedUnits = 0;
  const report = (frac = 0) => {
    if (!onProgress) return;
    const f = Math.min(Math.max(frac, 0), 1);
    let p = Math.floor((100 * (completedUnits + f)) / totalUnits);
    if (p > 99) p = 99; // 100 só ao concluir tudo
    if (p < 0) p = 0;
    onProgress(p);
  };
  report(0);

  // Prepara áudio fantasma se habilitado
  let hiddenAudioPath = null;
  if (settings.do_hidden_audio && hiddenFile) {
    hiddenAudioPath = `/tmp/${randPrefix}_hidden.wav`;
    const ok = await extractAudio(hiddenFile.path, hiddenAudioPath);
    if (!ok) {
      console.warn('Falha ao extrair áudio fantasma, ignorando.');
      hiddenAudioPath = null;
    }
    try { fs.unlinkSync(hiddenFile.path); } catch {}
  }

  // Anti-transcript inteligente: transcreve -> Claude acha palavras sensíveis
  // -> intervalos. Feito UMA vez (vale para todas as cópias).
  let smartRanges = [];
  let smartWords = [];
  if (settings.do_smart_antitranscribe) {
    const audioStt = `/tmp/${randPrefix}_stt.m4a`;
    try {
      const gotAudio = await extractAudioForStt(inputPath, audioStt, { durationSec, onProgress: report });
      completedUnits++; report(0);
      if (gotAudio) {
        console.log('smart: transcrevendo (AssemblyAI) + analisando com Claude...');
        const r = await analyzeSensitiveRanges(audioStt);
        smartRanges = r.ranges || [];
        smartWords = r.sensitive || [];
        console.log(`smart: ${smartWords.length} palavra(s) sensível(is):`, JSON.stringify(smartWords), 'ranges:', JSON.stringify(smartRanges));
      } else {
        console.warn('smart: falha ao extrair áudio, ignorando.');
      }
    } catch (e) {
      console.error('smart: análise falhou:', e.message);
    }
    try { fs.unlinkSync(audioStt); } catch {}
  }
  const useSmart = settings.do_smart_antitranscribe && smartRanges.length > 0;

  const generatedFiles = [];
  let lastFfmpegError = '';

  for (let i = 1; i <= numCopies; i++) {
    const randNum = randInt(1000, 9999);
    const base = `/tmp/${randPrefix}_${name}_${i}_${randNum}`;
    const useHalftone = settings.do_halftone;
    const useBumper = settings.do_image_bumper && bumperImagePath;
    const needsPost = useSmart || useHalftone || useBumper; // passes extras após o pass 1
    const finalOutput = `${base}${outExt}`;
    // Se houver passes extras (halftone/bumper), o pass 1 grava num intermediário.
    const outputFilename = needsPost ? `${base}_p1${outExt}` : finalOutput;

    const vfParts = [];
    let randVolume = 100;

    if (settings.do_uniqueize) {
      const randSize       = settings.randomize_resolution ? randInt(100, 110) : 100;
      randVolume           = settings.randomize_volume     ? randInt(100, 110) : 100;
      const randGamma      = settings.randomize_gamma      ? randInt(90, 100)  : 100;
      const randSaturation = settings.randomize_saturation ? randInt(100, 115) : 100;
      const randBrightness = settings.randomize_brightness ? randInt(0, 10) / 100 : 0;

      if (settings.randomize_resolution) {
        vfParts.push(`scale=ceil(iw*${randSize}/100/2)*2:-2`);
      }
      vfParts.push(
        `eq=gamma=${randGamma / 100}:saturation=${randSaturation / 100}:brightness=${randBrightness}`
      );
      vfParts.push('noise=alls=1:allf=t');
      vfParts.push('setsar=1');
    }

    // Ruído (CapCut): grão de filme temporal e visível, sobreposto ao vídeo.
    if (settings.do_capcut_noise) {
      vfParts.push(`noise=alls=${settings.capcut_noise_strength}:allf=t`);
    }

    // Monta filtros de áudio
    const useHidden = settings.do_hidden_audio && hiddenAudioPath;
    const vol = settings.do_hidden_audio ? settings.hidden_audio_volume : 0.03;

    let audioFilter = '';
    const extraInputs = useHidden ? ['-i', hiddenAudioPath] : [];

    if (useHidden) {
      let mainChain = '[0:a]';
      const mainFilters = [];
      if (settings.do_uniqueize && settings.randomize_volume) {
        mainFilters.push(`volume=${randVolume / 100}`);
      }
      if (settings.do_audio_antitranscribe && !useSmart) {
        mainFilters.push('pan=stereo|c0=FL|c1=-1*FR');
      }
      mainChain += (mainFilters.length ? mainFilters.join(',') + ',' : '') + 'aformat=sample_rates=48000[main_a]';

      const hiddenChain =
        `[1:a]aloop=loop=-1:size=2147483647,` +
        `bandpass=f=1500:width_type=o:width=4,` +
        `volume=${vol}[hidden_a]`;

      audioFilter = `${mainChain};${hiddenChain};[main_a][hidden_a]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
    } else {
      const afParts = [];
      if (settings.do_uniqueize && settings.randomize_volume) {
        afParts.push(`volume=${randVolume / 100}`);
      }
      if (settings.do_audio_antitranscribe && !useSmart) {
        afParts.push('pan=stereo|c0=FL|c1=-1*FR');
      }
      if (afParts.length > 0) {
        audioFilter = afParts.join(',');
      }
    }

    // Monta comando FFmpeg (pass 1)
    const args = ['-y', '-i', inputPath, ...extraInputs];

    if (settings.do_uniqueize || settings.do_capcut_noise) {
      args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-threads', '1', '-r', '30');
    }

    if (vfParts.length > 0) {
      args.push('-vf', vfParts.join(','));
    } else {
      args.push('-c:v', 'copy');
    }

    if (useHidden) {
      args.push('-filter_complex', audioFilter, '-map', '0:v', '-map', '[aout]');
    } else if (audioFilter) {
      args.push('-af', audioFilter);
    } else {
      args.push('-c:a', 'copy');
    }

    args.push(outputFilename);

    console.log(`FFmpeg cmd: ${ffmpegPath} ${args.join(' ')}`);
    try {
      const result = await runFfmpeg(args, { durationSec, onProgress: report });
      completedUnits++; report(0); // pass 1 concluído
      const outputExists = fs.existsSync(outputFilename);
      console.log(`FFmpeg status=${result.status} signal=${result.signal} outputExists=${outputExists}`);
      if (result.err) console.log('FFmpeg stderr (last 300):', result.err);

      const outputSize = outputExists ? fs.statSync(outputFilename).size : 0;
      const success = outputExists && outputSize > 1000;
      console.log(`FFmpeg outputSize=${outputSize} success=${success}`);

      if (success) {
        // Cadeia de passes extras: pass1 -> Smart-anti -> Halftone -> Bumper -> Compressão -> final
        let curFile = outputFilename;

        // Passe Anti-transcript inteligente (inversão só nos trechos sensíveis)
        if (useSmart) {
          const t = `${base}_ps${outExt}`;
          const s = await applySmartAntiTranscribe(curFile, smartRanges, t, { durationSec, onProgress: report });
          completedUnits++; report(0);
          if (s.ok) {
            try { fs.unlinkSync(curFile); } catch {}
            curFile = t;
          } else {
            lastFfmpegError = `smart: status=${s.status} signal=${s.signal} err=${s.err}`;
            console.error(`Smart-anti failed (copy ${i}):`, lastFfmpegError);
            try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch {}
          }
        }

        // Passe Halftone (overlay de textura de pontos)
        if (useHalftone) {
          const t = `${base}_ph${outExt}`;
          const ht = await applyHalftoneOverlay(curFile, settings.halftone_opacity, t, base, { durationSec, onProgress: report });
          completedUnits++; report(0);
          if (ht.ok) {
            try { fs.unlinkSync(curFile); } catch {}
            curFile = t;
          } else {
            lastFfmpegError = `halftone: status=${ht.status} signal=${ht.signal} err=${ht.err}`;
            console.error(`Halftone failed (copy ${i}):`, lastFfmpegError);
            try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch {}
          }
        }

        // Passe Bumper (imagem/GIF no início/fim)
        if (useBumper) {
          const t = `${base}_pb${outExt}`;
          const startDur = (randInt(1, 2) / 30).toFixed(3); // 1–2 frames a 30fps
          const b = await addImageBumper(curFile, bumperImagePath, settings.bumper_position, startDur, settings.bumper_end_seconds, t, bumperIsGif, { durationSec, onProgress: report });
          completedUnits++; report(0);
          if (b.ok) {
            try { fs.unlinkSync(curFile); } catch {}
            curFile = t;
          } else {
            lastFfmpegError = `bumper: status=${b.status} signal=${b.signal} err=${b.err}`;
            console.error(`Bumper failed (copy ${i}):`, lastFfmpegError);
            try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch {}
          }
        }

        // Renomeia o sobrevivente para o nome final (antes da compressão)
        if (curFile !== finalOutput) {
          try {
            if (fs.existsSync(finalOutput)) fs.unlinkSync(finalOutput);
            fs.renameSync(curFile, finalOutput);
          } catch (e) {
            console.error('rename final falhou:', e.message);
          }
        }

        // Passe Compressão: se ligado e o arquivo passar do limite, reencoda p/ ≤ limite.
        if (settings.do_compress_100mb) {
          const sz = fs.existsSync(finalOutput) ? fs.statSync(finalOutput).size : 0;
          if (sz > SIZE_LIMIT_BYTES && durationSec) {
            const t = `${base}_cz${outExt}`;
            const c = await compressUnderSize(finalOutput, durationSec, t, SIZE_LIMIT_BYTES, { onProgress: report });
            if (c.ok) {
              try { fs.unlinkSync(finalOutput); } catch {}
              fs.renameSync(t, finalOutput);
              if (c.size > SIZE_LIMIT_BYTES) {
                lastFfmpegError = `compress: melhor esforço ${(c.size / 1e6).toFixed(1)}MB (acima do limite)`;
                console.warn(lastFfmpegError);
              }
            } else {
              lastFfmpegError = `compress falhou: status=${c.status} signal=${c.signal} err=${c.err}`;
              console.error(`Compress failed (copy ${i}):`, lastFfmpegError);
              try { if (fs.existsSync(t)) fs.unlinkSync(t); } catch {}
            }
          } else if (sz > SIZE_LIMIT_BYTES && !durationSec) {
            lastFfmpegError = 'compress: duração desconhecida, não foi possível comprimir';
            console.warn(lastFfmpegError);
          }
          completedUnits++; report(0); // conta a unidade mesmo quando pula
        }

        generatedFiles.push(finalOutput);
      } else {
        lastFfmpegError = `status=${result.status} signal=${result.signal} outputExists=${outputExists} size=${outputSize} err=${result.err}`;
        console.error(`FFmpeg failed (copy ${i}):`, lastFfmpegError);
      }
    } catch (e) {
      lastFfmpegError = `spawn exception: ${e.message}`;
      console.error(`FFmpeg exception (copy ${i}):`, lastFfmpegError);
    }
  }

  try { fs.unlinkSync(inputPath); } catch {}
  if (hiddenAudioPath) { try { fs.unlinkSync(hiddenAudioPath); } catch {} }
  if (bumperFile) { try { fs.unlinkSync(bumperFile.path); } catch {} }

  return {
    generatedFiles,
    smartWords: settings.do_smart_antitranscribe ? smartWords : null,
    name,
    outExt,
    outputFormat: settings.output_format,
    error: generatedFiles.length === 0 ? (lastFfmpegError || 'Falha no processamento do vídeo.') : '',
  };
}

// ---------------------------------------------------------------------------
// Fila de jobs: cada vídeo enviado vira um job; processados UM DE CADA VEZ.
// ---------------------------------------------------------------------------
const jobs = new Map(); // id -> job
const queue = [];       // ids na ordem de chegada
let working = false;

function pump() {
  if (working) return;
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) return pump();
  working = true;
  job.status = 'processing';
  processJob(job)
    .catch((e) => {
      job.status = 'error';
      job.error = e.message || String(e);
    })
    .finally(() => {
      working = false;
      pump();
    });
}

async function processJob(job) {
  const { generatedFiles, smartWords, name, outExt, outputFormat, error } = await runPipeline({
    settings: job.settings,
    numCopies: job.numCopies,
    inputFile: job.inputFile,
    hiddenFile: job.hiddenFile,
    bumperFile: job.bumperFile,
    onProgress: (p) => { job.progress = p; },
  });

  job.smartWords = smartWords;

  if (!generatedFiles.length) {
    job.status = 'error';
    job.error = error;
    return;
  }

  // Empacota o resultado em disco para download posterior via GET.
  if (generatedFiles.length === 1) {
    job.resultPath = generatedFiles[0];
    job.resultName = `processed_${name}${outExt}`;
    job.resultType = outputFormat === 'mov' ? 'video/quicktime' : 'video/mp4';
  } else {
    const zipPath = `/tmp/${Date.now()}_${name}_processed.zip`;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const archive = archiver('zip');
      out.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(out);
      for (const f of generatedFiles) {
        archive.file(f, { name: path.basename(f) });
      }
      archive.finalize();
    });
    for (const f of generatedFiles) { try { fs.unlinkSync(f); } catch {} }
    job.resultPath = zipPath;
    job.resultName = `${name}_processed.zip`;
    job.resultType = 'application/zip';
  }

  job.progress = 100;
  job.status = 'done';
  job.doneAt = Date.now();
}

// Cria um job (recebe o arquivo + settings) e o coloca na fila.
app.post('/jobs', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'hidden_audio_file', maxCount: 1 },
  { name: 'bumper_image_file', maxCount: 1 }
]), (req, res) => {
  if (!req.files || !req.files['file']) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }
  const body = req.body || {};
  const settings = parseSettings(body);
  const numCopies = Math.max(1, parseInt(body.num_copies) || 1);

  const id = crypto.randomBytes(8).toString('hex');
  const job = {
    id,
    status: 'queued',
    progress: 0,
    error: '',
    settings,
    numCopies,
    inputFile: req.files['file'][0],
    hiddenFile: req.files['hidden_audio_file'] ? req.files['hidden_audio_file'][0] : null,
    bumperFile: req.files['bumper_image_file'] ? req.files['bumper_image_file'][0] : null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(id);
  console.log(`job ${id} enfileirado: ${job.inputFile.originalname} (${job.inputFile.size} bytes)`);
  pump();
  res.json({ jobId: id });
});

// Status do job (para a barra de progresso da UI).
app.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  res.json({
    status: job.status,
    progress: job.progress,
    error: job.error || '',
    resultReady: job.status === 'done',
    sensitiveWords: job.smartWords || null,
  });
});

// Baixa o resultado do job e limpa os arquivos temporários.
app.get('/jobs/:id/result', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status !== 'done' || !job.resultPath || !fs.existsSync(job.resultPath)) {
    return res.status(409).json({ error: 'Resultado ainda não disponível.' });
  }

  const filePath = job.resultPath;
  res.setHeader('Content-Disposition', `attachment; filename="${job.resultName}"`);
  res.setHeader('Content-Type', job.resultType || 'application/octet-stream');
  if (job.smartWords) {
    res.setHeader('Access-Control-Expose-Headers', 'X-Sensitive-Words');
    res.setHeader('X-Sensitive-Words', encodeURIComponent(JSON.stringify(job.smartWords)));
  }

  const cleanup = () => {
    try { fs.unlinkSync(filePath); } catch {}
    jobs.delete(job.id);
  };
  const stream = fs.createReadStream(filePath);
  stream.on('end', cleanup);
  stream.on('error', cleanup);
  stream.pipe(res);
});

// Varredura periódica: remove jobs órfãos (não baixados) após 60 min.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const age = now - (job.doneAt || job.createdAt);
    if (age > 60 * 60 * 1000) {
      if (job.resultPath) { try { fs.unlinkSync(job.resultPath); } catch {} }
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}, ffmpeg: ${ffmpegPath}`);
});
