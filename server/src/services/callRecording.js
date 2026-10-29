const fs = require('fs');
const path = require('path');

// Recordings captured from the live bidirectional media stream.
//
// VoBiz (the primary carrier) is dialled with a <Stream> element, not <Record>,
// so the carrier never produces an .mp3 for us — the stream is a raw socket and
// we simply throw the audio away. That left calls.recording_url NULL for every
// real call, which is why the Recording player was always missing. We record
// both halves ourselves here: the caller's inbound mu-law frames and the AI's
// outbound mu-law frames, mixed into one mono WAV.

const RECORDINGS_DIR = path.join(__dirname, '..', '..', 'public', 'recordings');

const SAMPLE_RATE = 8000;
const TICK_MS = 20;
const SAMPLES_PER_TICK = (SAMPLE_RATE * TICK_MS) / 1000; // 160

// Hard ceilings so a stuck socket cannot grow the buffer without bound.
const MAX_RECORDING_MS = 30 * 60 * 1000;
const MAX_TRACK_BYTES = 12 * 1024 * 1024; // ~25 min of 8 kHz mu-law per track

/**
 * Decode one G.711 mu-law byte to a 16-bit linear sample.
 * Standard reference expansion (invert, mantissa bias, exponent shift).
 */
function mulawToLinear(byte) {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  if (sign) sample = -sample;
  return sample;
}

/** Wrap a buffer of mu-law samples in a 16-bit PCM RIFF/WAVE header. */
function pcm16Wav(pcmBuffer) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt16LE(16, 16);       // PCM chunk size
  header.writeUInt16LE(1, 20);        // format 1 = PCM (universally playable)
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Mix timestamped mu-law tracks into a single mono 16-bit PCM WAV.
 *
 * Each track is a list of { t, buf } where t is milliseconds relative to the
 * call start. Everything is laid onto one sample grid and summed, so overlapping
 * speech mixes instead of overwriting, and gaps between segments come out as
 * silence for free.
 *
 * @param {Array<Array<{t:number, buf:Buffer}>>} tracks
 * @returns {{ wav: Buffer, durationSec: number }|null}
 */
function mixTracksToWav(tracks) {
  const segments = tracks.flat().filter((s) => s && s.buf && s.buf.length);
  if (!segments.length) return null;

  const t0 = Math.min(...segments.map((s) => s.t));
  const tEnd = Math.min(
    Math.max(...segments.map((s) => s.t + (s.buf.length / SAMPLE_RATE) * 1000)),
    t0 + MAX_RECORDING_MS
  );

  const totalSamples = Math.max(1, Math.ceil(((tEnd - t0) / 1000) * SAMPLE_RATE) + 1);
  const mix = new Float32Array(totalSamples);

  for (const seg of segments) {
    const startSample = Math.round(((seg.t - t0) / 1000) * SAMPLE_RATE);
    if (startSample < 0 || startSample >= totalSamples) continue;
    const end = Math.min(seg.buf.length, totalSamples - startSample);
    for (let i = 0; i < end; i++) {
      mix[startSample + i] += mulawToLinear(seg.buf[i]);
    }
  }

  // Scale down if the sum clipped, then clamp.
  let peak = 0;
  for (let i = 0; i < mix.length; i++) {
    const a = Math.abs(mix[i]);
    if (a > peak) peak = a;
  }
  const gain = peak > 32767 ? 32767 / peak : 1;

  const pcm = Buffer.allocUnsafe(totalSamples * 2);
  for (let i = 0; i < totalSamples; i++) {
    let v = Math.round(mix[i] * gain);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    pcm.writeInt16LE(v, i * 2);
  }

  return { wav: pcm16Wav(pcm), durationSec: Math.round((totalSamples / SAMPLE_RATE) * 10) / 10 };
}

/**
 * Persist a WAV to public/recordings and return the public URL path.
 * @returns {string|null} e.g. "/api/recordings/call_x_1712.wav"
 */
async function saveRecordingWav(callId, wavBuffer) {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length <= 44) return null;
  const safeName = String(callId || 'call').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'call';
  const fileName = `${safeName}_${Date.now()}.wav`;

  let localPath = null;
  try {
    if (!fs.existsSync(RECORDINGS_DIR)) {
      fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(path.join(RECORDINGS_DIR, fileName), wavBuffer);
    localPath = `/api/recordings/${fileName}`;
  } catch (err) {
    console.warn('[callRecording] Failed to write recording to disk:', err.message);
  }

  // Persist to InsForge storage so audio survives Render redeployments
  try {
    const { getInsforge } = require('../config/insforge');
    const insforge = await getInsforge();
    if (insforge) {
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      const uploadRes = await insforge.storage.from('recordings').upload(fileName, blob);
      if (uploadRes?.data?.url) {
        console.log(`[callRecording] Uploaded recording ${fileName} to InsForge storage:`, uploadRes.data.url);
        return uploadRes.data.url;
      }
    }
  } catch (err) {
    console.warn('[callRecording] InsForge storage upload error:', err.message);
  }

  return localPath;
}

function recordingFilePath(fileName) {
  // Resolve and confirm the result stays inside RECORDINGS_DIR so a crafted
  // name cannot escape the directory.
  const safeName = path.basename(String(fileName || ''));
  if (!safeName || !/^[\w.-]+\.(wav|mp3|m4a|ogg)$/i.test(safeName)) return null;
  const full = path.join(RECORDINGS_DIR, safeName);
  if (path.dirname(full) !== path.resolve(RECORDINGS_DIR)) return null;
  return full;
}

module.exports = { mixTracksToWav, saveRecordingWav, recordingFilePath, mulawToLinear, pcm16Wav };
