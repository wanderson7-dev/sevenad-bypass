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

app.post('/process/', upload.single('file'), async (req, res) => {
  if (!req.file) {
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
  };

  const numCopies = Math.max(1, parseInt(body.num_copies) || 1);
  const inputPath = req.file.path;
  const originalName = req.file.originalname || 'video.mp4';
  const ext = path.extname(originalName);
  const name = path.basename(originalName, ext);
  const randPrefix = randInt(10000, 99999);

  const generatedFiles = [];

  for (let i = 1; i <= numCopies; i++) {
    const randNum = randInt(1000, 9999);
    const outputFilename = `/tmp/${randPrefix}_${name}_${i}_${randNum}${ext}`;

    const vfParts = [];
    const afParts = [];
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

    if (settings.do_uniqueize && settings.randomize_volume) {
      afParts.push(`volume=${randVolume / 100}`);
    }

    if (settings.do_audio_antitranscribe) {
      afParts.push('pan=stereo|c0=FL|c1=-1*FR');
    }

    const args = ['-y', '-i', inputPath];

    if (settings.do_uniqueize) {
      args.push('-r', '30', '-crf', '28', '-preset', 'veryfast', '-b:v', '6.5M');
    }

    if (vfParts.length > 0) {
      args.push('-vf', vfParts.join(','));
    } else {
      args.push('-c:v', 'copy');
    }

    if (afParts.length > 0) {
      args.push('-af', afParts.join(','));
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
