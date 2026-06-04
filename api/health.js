const ffmpegPath = require('ffmpeg-static');
const { spawnSync } = require('child_process');

module.exports = function handler(req, res) {
  try {
    const result = spawnSync(ffmpegPath, ['-version'], { timeout: 5000 });
    const output = result.stdout?.toString() || result.stderr?.toString() || '';
    res.status(200).json({
      ok: result.status === 0,
      ffmpegPath,
      output: output.split('\n')[0],
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, ffmpegPath });
  }
};
