const express = require('express');
const multer = require('multer');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
// Usa ffmpeg do sistema (Docker/Railway) se disponível, senão usa ffmpeg-static (local)
const { execSync } = require('child_process');
let ffmpegPath;
try {
  ffmpegPath = execSync('which ffmpeg').toString().trim();
} catch {
  ffmpegPath = require('ffmpeg-static');
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

// Extrai o áudio de um arquivo (vídeo ou áudio) para um arquivo .wav temporário
function extractAudio(inputPath, outputPath) {
  const result = spawnSync(ffmpegPath, [
    '-y', '-i', inputPath,
    '-vn', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2',
    outputPath
  ], { timeout: 60000 });
  return result.status === 0;
}

// Anexa uma imagem (do usuário) no início e/ou no fim do vídeo.
// position: 'start' | 'end' | 'both'. startDur/endDur em segundos.
// A imagem é escalada para casar com a resolução do vídeo (scale com input de
// referência: rw/rh) e áudio silencioso (anullsrc) preenche os trechos adicionados.
function addImageBumper(inputPath, imagePath, position, startDur, endDur, outputPath, isGif) {
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
  const result = spawnSync(ffmpegPath, args, { timeout: 300000 });
  const ok = fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
  if (!ok && result.stderr) console.log('Bumper stderr (last 500):', result.stderr.toString().slice(-500));
  return {
    ok,
    err: result.stderr?.toString().slice(-300) || '',
    status: result.status,
    signal: result.signal,
  };
}

app.post('/process/', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'hidden_audio_file', maxCount: 1 },
  { name: 'bumper_image_file', maxCount: 1 }
]), async (req, res) => {
  if (!req.files || !req.files['file']) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const body = req.body || {};
  const settings = {
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
  };

  console.log('settings:', JSON.stringify(settings));
  const numCopies = Math.max(1, parseInt(body.num_copies) || 1);
  const inputFile = req.files['file'][0];
  console.log('inputFile:', inputFile?.originalname, inputFile?.size, inputFile?.path, 'exists:', fs.existsSync(inputFile?.path));
  const hiddenFile = req.files['hidden_audio_file'] ? req.files['hidden_audio_file'][0] : null;
  const bumperFile = req.files['bumper_image_file'] ? req.files['bumper_image_file'][0] : null;
  const bumperImagePath = (settings.do_image_bumper && bumperFile) ? bumperFile.path : null;
  const bumperIsGif = !!bumperFile && (
    /gif/i.test(bumperFile.mimetype || '') || /\.gif$/i.test(bumperFile.originalname || '')
  );

  const inputPath = inputFile.path;
  const originalName = inputFile.originalname || 'video.mp4';
  const ext = path.extname(originalName);
  const name = path.basename(originalName, ext);
  const randPrefix = randInt(10000, 99999);

  // Prepara áudio fantasma se habilitado
  let hiddenAudioPath = null;
  if (settings.do_hidden_audio && hiddenFile) {
    hiddenAudioPath = `/tmp/${randPrefix}_hidden.wav`;
    const ok = extractAudio(hiddenFile.path, hiddenAudioPath);
    if (!ok) {
      console.warn('Falha ao extrair áudio fantasma, ignorando.');
      hiddenAudioPath = null;
    }
    try { fs.unlinkSync(hiddenFile.path); } catch {}
  }

  const generatedFiles = [];
  let lastFfmpegError = '';

  for (let i = 1; i <= numCopies; i++) {
    const randNum = randInt(1000, 9999);
    const useBumper = settings.do_image_bumper && bumperImagePath;
    const finalOutput = `/tmp/${randPrefix}_${name}_${i}_${randNum}${ext}`;
    // Se o bumper estiver ativo, o pass 1 grava num arquivo intermediário e o
    // pass 2 (addImageBumper) gera o arquivo final.
    const outputFilename = useBumper
      ? `/tmp/${randPrefix}_${name}_${i}_${randNum}_p1${ext}`
      : finalOutput;

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

    // Monta filtros de áudio
    const useHidden = settings.do_hidden_audio && hiddenAudioPath;
    const vol = settings.do_hidden_audio ? settings.hidden_audio_volume : 0.03;

    let audioFilter = '';
    const extraInputs = useHidden ? ['-i', hiddenAudioPath] : [];

    if (useHidden) {
      // Áudio fantasma na faixa audível (fala: 300Hz–5kHz) a volume baixo.
      // Humano ouve como "barulho de fundo suave"; IA de transcrição capta e se confunde.
      let mainChain = '[0:a]';
      const mainFilters = [];
      if (settings.do_uniqueize && settings.randomize_volume) {
        mainFilters.push(`volume=${randVolume / 100}`);
      }
      if (settings.do_audio_antitranscribe) {
        mainFilters.push('pan=stereo|c0=FL|c1=-1*FR');
      }
      mainChain += (mainFilters.length ? mainFilters.join(',') + ',' : '') + 'aformat=sample_rates=48000[main_a]';

      // Loop o fantasma para cobrir toda a duração, mantém na faixa de fala (bandpass 300–5000Hz)
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
      if (settings.do_audio_antitranscribe) {
        afParts.push('pan=stereo|c0=FL|c1=-1*FR');
      }
      if (afParts.length > 0) {
        audioFilter = afParts.join(',');
      }
    }

    // Monta comando FFmpeg
    const args = ['-y', '-i', inputPath, ...extraInputs];

    if (settings.do_uniqueize) {
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
      const result = spawnSync(ffmpegPath, args, { timeout: 300000 });
      const ffmpegErr = result.stderr?.toString() || '';
      const ffmpegOut = result.stdout?.toString() || '';
      const outputExists = fs.existsSync(outputFilename);

      console.log(`FFmpeg status=${result.status} signal=${result.signal} outputExists=${outputExists}`);
      if (ffmpegErr) console.log('FFmpeg stderr (last 500):', ffmpegErr.slice(-500));

      const outputSize = outputExists ? fs.statSync(outputFilename).size : 0;
      const success = outputExists && outputSize > 1000; // arquivo válido

      console.log(`FFmpeg outputSize=${outputSize} success=${success}`);

      if (success) {
        if (useBumper) {
          const startDur = (randInt(1, 2) / 30).toFixed(3); // 1–2 frames a 30fps
          const b = addImageBumper(outputFilename, bumperImagePath, settings.bumper_position, startDur, settings.bumper_end_seconds, finalOutput, bumperIsGif);
          if (b.ok) {
            try { fs.unlinkSync(outputFilename); } catch {}
            generatedFiles.push(finalOutput);
          } else {
            // Fallback: se o bumper falhar, ainda entrega o vídeo processado
            lastFfmpegError = `bumper: status=${b.status} signal=${b.signal} err=${b.err}`;
            console.error(`Bumper failed (copy ${i}):`, lastFfmpegError);
            try { if (fs.existsSync(finalOutput)) fs.unlinkSync(finalOutput); } catch {}
            generatedFiles.push(outputFilename);
          }
        } else {
          generatedFiles.push(outputFilename);
        }
      } else {
        lastFfmpegError = `status=${result.status} signal=${result.signal} outputExists=${outputExists} size=${outputSize} err=${ffmpegErr.slice(-300) || ffmpegOut.slice(-300)}`;
        console.error(`FFmpeg failed (copy ${i}):`, lastFfmpegError);
      }
    } catch (e) {
      lastFfmpegError = `spawnSync exception: ${e.message}`;
      console.error(`FFmpeg exception (copy ${i}):`, lastFfmpegError);
    }
  }

  try { fs.unlinkSync(inputPath); } catch {}
  if (hiddenAudioPath) { try { fs.unlinkSync(hiddenAudioPath); } catch {} }
  if (bumperFile) { try { fs.unlinkSync(bumperFile.path); } catch {} }

  if (generatedFiles.length === 0) {
    return res.status(500).json({ error: 'Falha no processamento do vídeo.', detail: lastFfmpegError });
  }

  const cleanup = () => {
    generatedFiles.forEach((f) => { try { fs.unlinkSync(f); } catch {} });
  };

  if (generatedFiles.length === 1) {
    const filePath = generatedFiles[0];
    const niceName = `processed_${originalName}`;
    res.setHeader('Content-Disposition', `attachment; filename="${niceName}"`);
    res.setHeader('Content-Type', 'video/mp4');
    const stream = fs.createReadStream(filePath);
    stream.on('end', cleanup);
    stream.on('error', cleanup);
    return stream.pipe(res);
  }

  const zipPath = `/tmp/${randPrefix}_${name}_processed.zip`;
  const niceName = `${name}_processed.zip`;
  res.setHeader('Content-Disposition', `attachment; filename="${niceName}"`);
  res.setHeader('Content-Type', 'application/zip');

  const archive = archiver('zip');
  archive.on('end', cleanup);
  archive.pipe(res);

  for (const f of generatedFiles) {
    const zipItemName = path.basename(f).replace(`${randPrefix}_`, '');
    archive.file(f, { name: zipItemName });
  }

  await archive.finalize();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}, ffmpeg: ${ffmpegPath}`);
});
