const express = require('express');
const multer = require('multer');
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const upload = multer({ dest: '/tmp' });

app.use(express.static(path.join(__dirname, 'public')));

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

app.post('/process/', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'hidden_audio_file', maxCount: 1 }
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
  };

  const numCopies = Math.max(1, parseInt(body.num_copies) || 1);
  const inputFile = req.files['file'][0];
  const hiddenFile = req.files['hidden_audio_file'] ? req.files['hidden_audio_file'][0] : null;

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

  for (let i = 1; i <= numCopies; i++) {
    const randNum = randInt(1000, 9999);
    const outputFilename = `/tmp/${randPrefix}_${name}_${i}_${randNum}${ext}`;

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
      args.push('-r', '30', '-crf', '28', '-preset', 'veryfast', '-b:v', '6.5M');
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

    console.log(`Running FFmpeg copy ${i}...`);
    const result = spawnSync(ffmpegPath, args, { timeout: 300000 });

    if (result.status === 0) {
      generatedFiles.push(outputFilename);
    } else {
      console.error(`FFmpeg error (copy ${i}):`, result.stderr?.toString());
    }
  }

  try { fs.unlinkSync(inputPath); } catch {}
  if (hiddenAudioPath) { try { fs.unlinkSync(hiddenAudioPath); } catch {} }

  if (generatedFiles.length === 0) {
    return res.status(500).json({ error: 'Falha no processamento do vídeo.' });
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
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
