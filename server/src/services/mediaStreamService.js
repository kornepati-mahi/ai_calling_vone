const WebSocket = require('ws');
const { queryOne, insert, update } = require('../config/db');
const { getAIProvider, getVoiceProvider } = require('../providers');
const { SarvamProvider } = require('../providers/voice/sarvam');
const { CartesiaProvider } = require('../providers/voice/cartesia');
const { DeepgramProvider } = require('../providers/voice/deepgram');
const realtime = require('./realtime');
const { AppError } = require('../utils/errors');
const { calculateCallCost, getVoicePerMinuteRate, debit, getWallet } = require('./credits');
const { mixTracksToWav, saveRecordingWav, mulawToLinear } = require('./callRecording');
const { buildSystemPrompt, loadEmployeeKnowledge } = require('./systemPrompt');

// Per-side ceiling on captured mu-law (~25 min of 8 kHz per side).
const MAX_RECORDING_TRACK_BYTES = 12 * 1024 * 1024;

/**
 * How much of `text` is repeated inside `haystack`, as a 0..1 score.
 *
 * Used to recognise the AI's own voice coming back through the caller's handset.
 * Character n-grams rather than words, because Telugu is written as long runs
 * with few spaces, so word splitting is unreliable. Punctuation and whitespace
 * are stripped first so a re-render of the same sentence still matches.
 */
function echoTextScore(text, haystack) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const a = norm(text);
  const b = norm(haystack);
  if (a.length < 4 || b.length < 4) return 0;
  if (b.includes(a)) return 1;
  const N = 4;
  if (a.length < N) return 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + N <= a.length; i++) {
    total++;
    if (b.includes(a.slice(i, i + N))) hit++;
  }
  return total ? hit / total : 0;
}

/**
 * Returns true when the given text is primarily Latin/English script.
 * We count the ratio of ASCII letters to total letters; if > 60% ASCII
 * and the string is at least 4 characters, we treat it as English.
 * Short words like "ok", "yes", "no" are excluded — they are allowed
 * as back-channels and must NOT be translated.
 */
function isEnglishText(text) {
  if (!text || text.length < 4) return false;
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return false;
  const asciiLetters = letters.filter((c) => /[a-zA-Z]/.test(c)).length;
  return asciiLetters / letters.length > 0.6;
}

/**
 * True when the caller's turn actually asks for something.
 *
 * Rejects bare acknowledgements and one-word noise, which on a noisy line is what
 * STT produces from echo or line hiss. Counting script characters (not bytes)
 * matters here: Telugu is multi-byte, so "ఆ." is two characters but four bytes.
 */
/**
 * Normalises an utterance for comparison: lower case, and every character that
 * is not a letter or digit removed - including spaces and punctuation.
 *
 * Spaces have to go. Telugu conjuncts and STT output both arrive with stray
 * whitespace, and an earlier version of this list compared on spaced text and so
 * missed "అవును" that had been stored as అవ + space + న. Comparing on a flat form
 * makes the match immune to that.
 */
function normalizeUtterance(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

const GREETINGS = new Set(
  [
    'హలో', 'హల్లో', 'hello', 'hi', 'నమస్కారం', 'నమస్తే', 'చెప్పండి', 'హాచెప్పండి',
    'halo', 'hallo', 'hey', 'నమస్తేనమస్తే', 'హలోహలో', 'hellohello'
  ].map(normalizeUtterance)
);

function isGreetingUtterance(text) {
  const flat = normalizeUtterance(text);
  if (GREETINGS.has(flat)) return true;
  const words = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 2 && words.some(w => GREETINGS.has(normalizeUtterance(w)))) return true;
  return false;
}

const BACKCHANNEL = new Set(
  [
    'ఆ', 'అవును', 'అవు', 'హ', 'సరే', 'ఓకి', 'థాంక్స్', 'ధన్యవాదాలు',
    'ok', 'okay', 'yes', 'no', 'hmm', 'uh', 'uhm', 'ah', 'oh',
    'fine', 'good', 'right', 'sure', 'ha',
    'avunu', 'saré', 'sare', 'thanks', 'thankyou', 'haan', 'ki',
    'హహ', 'ఆఆ', 'అవునుఅవును',
    'okayokay', 'yeyes', 'yesyes', 'nono', 'hmmhmm',
  ].map(normalizeUtterance)
);

function isSubstantiveUtterance(text) {
  const flat = normalizeUtterance(text);
  if (!flat || flat.length < 2) return false;
  // Pure filler sounds that carry no intent
  const FILLERS = new Set(['hmm', 'uh', 'uhm', 'హ్మ్', 'హహ', 'hmmhmm']);
  if (FILLERS.has(flat)) return false;
  return true;
}

function detectEndingIntent(userText, messages = []) {
  const norm = String(userText || '').toLowerCase().replace(/[.,!?;:()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return false;

  // 1. Direct explicit termination commands (always end)
  const explicitTerms = [
    'bye', 'బాయ్', 'గుడ్ బాయ్', 'goodbye',
    'కట్ ద కాల్', 'కాల్ కట్', 'కట్ చేయండి', 'కట్ చేయి', 'కట్ చేయు',
    'cut the call', 'cut call', 'disconnect',
    'ఫోన్ పెట్టేయండి', 'ఫోన్ పెట్టేస్తా', 'ఫోన్ కట్', 'పెట్టేయండి', 'పెట్టేస్తా',
    'హ్యాంగ్ అప్', 'hang up',
    'థాంక్యూ చాలు', 'థాంక్స్ చాలు', 'ఇక చాలు', 'ఇంతే చాలు', 'వద్దు చాలు'
  ];
  if (explicitTerms.some((t) => norm.includes(t))) {
    return true;
  }

  // 2. Customer saying "thank you" / "thanks" after at least 1 turn of conversation (call concluding)
  const thankTerms = [
    'థాంక్యూ', 'థాంక్స్', 'థాంక్స్ అండి', 'థాంక్యూ అండి',
    'ఓకే థాంక్యూ', 'ఓకే థాంక్స్', 'ఓకే అండి థాంక్యూ', 'థాంక్యూ సో మచ్',
    'ధన్యవాదాలు', 'ధన్యవాదాలు అండి',
    'thank you', 'thanks', 'ok thank you', 'ok thanks', 'thank you so much'
  ];
  if (messages.length >= 3 && thankTerms.some((t) => norm === t || norm.startsWith(t + ' ') || norm.endsWith(' ' + t) || norm.includes(' ' + t + ' '))) {
    return true;
  }

  // 3. Customer saying "no / nothing / that's all / enough"
  const negativeAnswers = [
    'ఏం లేదు', 'ఏమీ లేదు', 'ఇంకేం లేదు', 'ఇంకా ఏం లేదు', 'ఇంకేమీ లేదు',
    'లేదు', 'లేదండి', 'నో', 'వద్దు', 'వద్దండి', 'నాకేం వద్దు',
    'no', 'nope', 'nothing', 'no thanks', 'nothing else', 'no questions',
    'అంతే', 'అంతే అండి', 'చాలు', 'చాలండి', 'ఇక చాలు', 'అవసరం లేదు', 'సరిపోతుంది'
  ];
  const isNegative = negativeAnswers.some((w) => {
    return norm === w || norm.startsWith(w + ' ') || norm.endsWith(' ' + w) || norm.includes(' ' + w + ' ');
  });

  if (isNegative) {
    // If conversation is already underway (messages >= 3), saying "nothing / no / that's all" means they are done
    if (messages.length >= 3) {
      return true;
    }
    // Check if the previous assistant message asked if they have more questions or need more info
    const lastAiMsg = (messages.slice(0, -1).reverse().find((m) => m.role === 'assistant')?.content || '').toLowerCase();
    const isAiAskingMore = [
      'ఇంకా ఏదైనా', 'ఇంకేమైనా', 'ఇంకా ఏమైనా', 'సందేహాలు', 'ప్రశ్నలు',
      'అడగుదామా', 'అడగండి', 'వివరాలు కావాలా', 'సహాయం కావాలా', 'వివరాలు పంపించమంటారా',
      'anything else', 'any other', 'any questions'
    ].some((q) => lastAiMsg.includes(q));

    if (isAiAskingMore) {
      return true;
    }
  }

  // 4. Customer confirming attendance / next step after assistant proposed it (e.g. "ఓకే", "సరే", "ఓకే ఓకే", "తప్పకుండా", "హా")
  const confirmTerms = [
    'ఓకే', 'సరే', 'హా', 'అవును', 'తప్పకుండా', 'ఓకే ఓకే', 'ఓకే అండి', 'సరే అండి', 'ఓకేనా',
    'ok', 'okay', 'sure', 'ok ok', 'yeah', 'yes', 'alright'
  ];
  const isConfirm = confirmTerms.some((t) => norm === t || norm === `${t} ${t}`);
  if (isConfirm && messages.length >= 4) {
    const lastAiMsg = (messages.slice(0, -1).reverse().find((m) => m.role === 'assistant')?.content || '').toLowerCase();
    const isAiClosingProposal = [
      'హాజరవుతారా', 'వస్తారా', 'కలుద్దామా', 'కన్ఫర్మ్', 'డెమో', 'డెమో సెషన్', 'సమయం', '7 గంటలకు', '7 pm',
      'సాయంత్రం', 'రిజిస్టర్', 'విజిట్', 'అపాయింట్‌మెంట్', 'attend', 'join', 'confirm', 'demo'
    ].some((k) => lastAiMsg.includes(k));
    if (isAiClosingProposal) {
      return true;
    }
  }

  return false;
}

class MediaStreamSession {
  constructor({ ws, provider = 'vobiz', callId, employeeId, orgId = null }) {
    this.ws = ws;
    this.provider = provider; // 'vobiz' or 'twilio'
    this.callId = callId;
    this.employeeId = employeeId;
    this.streamSid = null;
    this.callSid = null;
    this.callDbId = null;
    // Carrier identifiers needed to hang the PSTN leg up at the end of the call.
    this.carrierCallUuid = null;
    this.requestId = null;
    this.carrierHungUp = false;
    // Set from start.mediaFormat; defaults match what the answer XML requests.
    this.mediaFormat = { encoding: 'mulaw', sampleRate: 8000 };
    // orgId is the tenant this session is pinned to. Set from the call row (or
    // asserted by the caller for a browser socket) and never widened later.
    this.orgId = orgId;
    this.employee = null;
    this.employeeKnowledge = null;

    this.audioBuffer = []; // incoming caller audio chunks
    this.preSpeechBuffer = []; // ring buffer to preserve word onset consonants
    this.isUserSpeaking = false;
    this.pendingAudio = null; // audio captured during a processing turn, played next
    this.isAiSpeaking = false;
    this.isProcessingSpeech = false;
    this.messages = [];
    this.transcript = [];
    this.bloodGroup = null; // blood group detected from caller speech (e.g. 'B+')
    this.silenceTimer = null;
    this.exitTimer = null; // graceful call disconnect timer after farewell playback
    this.isClosing = false; // true when AI has delivered farewell and call is terminating
    this.startTime = Date.now();
    this.aiPlaybackCursor = 0; // tracks physical playback timeline for AI speech
    this.activeUtteranceBytes = 0;
    this.hasGreeted = false;
    this.bargeInFrames = 0;
    this.diag = { mediaChunks: 0, lastDiagTs: 0, lastEnergyLog: 0 };
    this.sentRows = []; // recent TTS audio we sent (for echo suppression, oldest->newest)
    this.echoHits = 0;
    this.echoMisses = 0;
    this.recentAiSpeech = [];
    this.clarifyCount = 0;
    this.noiseFloor = 20; // baseline line noise (typically 15-25 RMS on telephony)
    this.speechRun = 0;   // consecutive speech-like frames
    this.silenceRun = 0;

    // Rolling capture of both halves of the call. VoBiz is dialled with <Stream>,
    // not <Record>, so the carrier hands back no .mp3 and every real call ended
    // with calls.recording_url NULL — the dashboard's audio player had nothing to
    // load. We keep our own copy of the customer's inbound mu-law and the AI's
    // outbound mu-law and mix them on finish.
    this.recCustomer = [];
    this.recAi = [];
    this.recCustomerBytes = 0;
    this.recAiBytes = 0;

    this.ai = getAIProvider('groq');
    this.cartesia = new CartesiaProvider();
    this.sarvam = new SarvamProvider();
    this.deepgram = new DeepgramProvider();
  }

  /**
   * Persist the carrier's CallUUID once the call row is known.
   *
   * The `start` frame routinely beats init(), because the carrier opens the
   * socket and sends it immediately while the call-row lookup is still in
   * flight. The value is therefore remembered and replayed the moment
   * callDbId is set - otherwise the very first callback carrying only CallUUID
   * would match nothing and the call would never be closed out.
   */
  #recordCarrierCallUuid(callUuid) {
    if (!callUuid) return;
    this.pendingCarrierCallUuid = String(callUuid);
    if (!this.callDbId) return;
    const { update } = require('../config/db');
    const value = this.pendingCarrierCallUuid;
    this.pendingCarrierCallUuid = null;
    update(
      'UPDATE calls SET carrier_call_uuid = ? WHERE id = ? AND (carrier_call_uuid IS NULL OR carrier_call_uuid = ?)',
      [value, this.callDbId, value]
    ).catch(() => {});
  }

  async init() {
    try {
      const call = await queryOne(
        `SELECT calls.*, l.name AS lead_name, l.purpose AS lead_purpose, l.company AS lead_company
         FROM calls
         LEFT JOIN leads l ON l.id = calls.lead_id
         WHERE calls.call_id = ? OR calls.request_id = ?
         ORDER BY calls.id DESC LIMIT 1`,
        [this.callId, this.callId]
      );
      if (call) {
        this.callDbId = call.id;
        // The WebSocket `start` frame may already have arrived with the
        // carrier's CallUUID while this lookup was in flight.
        if (this.pendingCarrierCallUuid) this.#recordCarrierCallUuid(this.pendingCarrierCallUuid);
        this.orgId = call.organization_id || this.orgId;
        const rawLeadName = (call.lead_name || '').trim();
        const rawPurpose = (call.lead_purpose || '').trim();
        this.lead = {
          id: call.lead_id,
          name: rawLeadName && rawLeadName !== 'Customer' && rawLeadName !== 'Instant Lead' && rawLeadName.toLowerCase() !== 'optional' ? rawLeadName : null,
          purpose: rawPurpose && rawPurpose.toLowerCase() !== 'optional' ? rawPurpose : null,
          company: call.lead_company || null,
        };
        console.log(`[mediaStream] Loaded lead for call ${this.callId}: name="${this.lead.name || 'none'}", purpose="${this.lead.purpose || 'none'}"`);
      }

      // Scope the employee to this session's tenant. The previous code loaded by
      // id alone and then fell back to employee 3 / "any employee", so a socket
      // naming an id from another organization would have been answered by that
      // tenant's employee, and its prompt and knowledge.
      if (this.orgId) {
        this.employee = await queryOne(
          'SELECT * FROM ai_employees WHERE id = ? AND organization_id = ?',
          [this.employeeId, this.orgId]
        );
      } else {
        console.warn(`[mediaStream] No tenant resolved for call ${this.callId}; refusing to start a session.`);
        this.send({ event: 'error', message: 'No organization for this call.' });
        return;
      }

      if (!this.employee) {
        console.warn(`[mediaStream] Employee ${this.employeeId} not found in org ${this.orgId}.`);
        this.send({ event: 'error', message: 'Employee not found for this call.' });
        return;
      }

      console.log(`[mediaStream] Session initialized for ${this.provider.toUpperCase()} | Call: ${this.callId} | Employee: ${this.employee?.name} | Org: ${this.orgId}`);

      // Load trained knowledge once per session rather than on every turn: it
      // cannot change mid-call, and re-reading five tables per reply would add
      // latency to the live path.
      try {
        this.employeeKnowledge = await loadEmployeeKnowledge(this.employeeId);
      } catch (err) {
        console.warn(`[mediaStream] Could not load knowledge for employee ${this.employeeId}: ${err.message}`);
        this.employeeKnowledge = null;
      }

      // Initialize conversation engine via Engine Adapter
      // (CartesiaLineEngine as default when cartesia_agent_id exists, PipelineEngine as fallback)
      try {
        const { createEngine } = require('./engines');
        this.engine = await createEngine({
          employee: this.employee,
          lead: this.lead,
          session: this,
          orgId: this.orgId,
          employeeKnowledge: this.employeeKnowledge,
        });
        this.engineUsed = this.engine?.name || 'pipeline';
        if (this.callDbId) {
          update('UPDATE calls SET engine_used = ? WHERE id = ?', [this.engineUsed, this.callDbId]).catch(() => {});
        }
        if (this._pendingAudioInitBuffer && this._pendingAudioInitBuffer.length) {
          const buffered = this._pendingAudioInitBuffer;
          this._pendingAudioInitBuffer = [];
          for (const c of buffered) {
            this.engine.handleInboundAudio(c);
          }
        }
      } catch (engineErr) {
        console.error(`[mediaStream] Failed to initialize engine adapter: ${engineErr.message}`);
        setTimeout(() => this.playInitialGreeting(), 600);
      }
    } catch (err) {
      console.error('[mediaStream] Init error:', err.message);
    }
  }

  async playInitialGreeting() {
    if (this.hasGreeted) return;
    this.hasGreeted = true;

    // VoBiz requires a streamId echoed back on every playAudio, and silently
    // drops frames without one, so wait for its start event. Twilio's <Stream>
    // has no streamId at all - it is a single bidirectional socket - so there is
    // nothing to wait for.
    if (this.provider === 'vobiz') {
      const deadline = Date.now() + 8000;
      while (!this.streamSid && Date.now() < deadline) {
        await sleep(150);
      }
      if (!this.streamSid) {
        console.warn('[mediaStream] Greeting skipped: no streamSid received from VoBiz start event.');
        return;
      }
    }

    const leadName = (this.lead?.name || '').trim();
    const leadPurpose = (this.lead?.purpose || '').trim();
    const lang = (this.employee?.language_code || 'te').toLowerCase();
    const leadHonorific = leadName ? (
      lang.startsWith('hi') ? `${leadName} जी` :
      lang.startsWith('en') ? leadName :
      `${leadName} గారు`
    ) : '';

    let greeting = (this.employee?.greeting || `నమస్కారం! నేను ${this.employee?.name || 'అసిస్టెంట్'} ని మాట్లాడుతున్నాను. మీకు ఎలా సహాయపడగలను?`)
      .replace('{name}', this.employee?.name || 'అసిస్టెంట్');

    // Replace lead placeholders if present
    if (leadHonorific) {
      greeting = greeting.replace(/\{lead_name\}|\{customer_name\}|\{lead\}|\{customer\}/gi, leadHonorific);
    }
    if (leadPurpose) {
      greeting = greeting.replace(/\{purpose\}|\{reason\}/gi, leadPurpose);
    }

    // If template did not explicitly include the lead's name, naturally insert it into the opening
    if (leadHonorific && !greeting.includes(leadName)) {
      const isTe = !lang.startsWith('en') && !lang.startsWith('hi');
      const isHi = lang.startsWith('hi');
      const teMatch = greeting.match(/^(\s*)(నమస్కారం|నమస్తే)(\s*అండి)?([\s,!.–—]+)(.*)$/i);
      const teHello = greeting.match(/^(\s*)(హలో)([\s,!.–—]+)(.*)$/i);
      const hiMatch = greeting.match(/^(\s*)(नमस्ते|नमस्कार)(\s*जी)?([\s,!.–—]+)(.*)$/i);
      const enMatch = greeting.match(/^(\s*)(Hello|Hi)(\s*there)?([\s,!.–—]+)(.*)$/i);
      if (teMatch) {
        greeting = `${teMatch[2]} ${leadHonorific}! ${teMatch[5]}`;
      } else if (teHello) {
        greeting = `హలో ${leadHonorific}! ${teHello[4]}`;
      } else if (hiMatch) {
        greeting = `${hiMatch[2]} ${leadHonorific}! ${hiMatch[5]}`;
      } else if (enMatch) {
        greeting = `${enMatch[2]} ${leadHonorific}! ${enMatch[5]}`;
      } else {
        greeting = isTe ? `నమస్కారం ${leadHonorific}! ${greeting}` : isHi ? `नमस्ते ${leadHonorific}! ${greeting}` : `Hello ${leadHonorific}! ${greeting}`;
      }
    }

    this.messages.push({ role: 'assistant', content: greeting });
    this.addTranscript('ai', greeting);
    this.isGreeting = true;
    try {
      await this.speak(greeting);
    } finally {
      this.isGreeting = false;
    }
  }

  handleVoBizMessage(msg) {
    switch (msg.event) {
      case 'start':
        // The documented shape is start.streamId / start.callId, but carriers and
        // proxies have been seen to flatten those to the top level. Prefer the
        // nested documented keys and fall back rather than the other way round.
        const start = msg.start && typeof msg.start === 'object' ? msg.start : msg;
        this.streamSid = start.streamId || start.streamSid || start.stream_sid || msg.streamId || this.streamSid;
        this.callSid = start.callId || start.callSid || start.call_sid || msg.callId || this.callId;

        // start.callId is the CallUUID the REST API and callbacks also use, which
        // is exactly what hangupCall needs, so keep it for the end of the call.
        this.carrierCallUuid = this.callSid;
        this.#recordCarrierCallUuid(this.callSid);

        // The docs require reading start.mediaFormat per connection and decoding
        // every media.payload with it. It was previously ignored and mu-law/8 kHz
        // assumed unconditionally, which only worked because the XML pinned
        // contentType. Honour whatever the carrier actually negotiated.
        if (start.mediaFormat) {
          this.mediaFormat = {
            encoding: String(start.mediaFormat.encoding || 'mulaw').toLowerCase(),
            sampleRate: Number(start.mediaFormat.sampleRate) || 8000,
          };
          console.log(`[vobiz] Stream media format: ${this.mediaFormat.encoding} @ ${this.mediaFormat.sampleRate}`);
        }

        console.log(`[vobiz] Stream started: streamSid=${this.streamSid}, callSid=${this.callSid}`);
        break;

      case 'media':
        if (!this.streamSid && (msg.streamId || msg.streamSid || msg.stream_sid)) {
          this.streamSid = msg.streamId || msg.streamSid || msg.stream_sid;
        }
        if (msg.media?.payload) {
          const rawChunk = Buffer.from(msg.media.payload, 'base64');
          this.processInboundAudioChunk(rawChunk);
        }
        break;

      case 'checkpoint':
        break;

      // VoBiz confirms a checkpoint was played back. This is the only
      // documented, measured signal that the caller has actually HEARD an
      // utterance - the previous code inferred it from bytes sent, which drifts
      // whenever the carrier buffers. The event echoes the `name` we set on the
      // checkpoint, so a mismatch means it belongs to a different utterance.
      case 'playedStream':
        // Ignore an ack for a checkpoint we are no longer waiting on, so a late
        // confirmation cannot be mistaken for the current utterance finishing.
        if (this._pendingCheckpointName && msg.name && msg.name !== this._pendingCheckpointName) {
          console.warn(`[vobiz] playedStream for "${msg.name}" ignored; awaiting "${this._pendingCheckpointName}"`);
          break;
        }
        this.onPlaybackConfirmed();
        if (this.engine?.onPlaybackConfirmed) {
          try { this.engine.onPlaybackConfirmed(); } catch {}
        }
        break;

      // VoBiz sends clearedAudio after our clearAudio command is processed.
      // Per docs: "Confirms queued playback was cleared." This is the definitive
      // signal that the AI's outbound queue is empty and the PSTN speaker has
      // gone quiet.
      case 'clearedAudio':
        this.isAiSpeaking = false;
        this.playbackEndTime = 0;
        this.bargeInFrames = 0;
        console.log('[vobiz] clearedAudio confirmed – AI playback stopped');
        if (this.engine?.onPlaybackCleared) {
          try { this.engine.onPlaybackCleared(); } catch {}
        }
        // Playback ended here rather than at a checkpoint, so a caller
        // barging in would otherwise leave speak() waiting on a playedStream
        // that is never coming.
        if (this._pendingCheckpoint) {
          const resolve = this._pendingCheckpoint;
          this._pendingCheckpoint = null;
          resolve();
        }
        break;

      // VoBiz has no inbound `stop` event: end-of-stream is the WebSocket close,
      // which is what the ws.on('close') handler below uses. Kept only so an
      // out-of-contract carrier that does send one is not mistaken for a fault.
      case 'stop':
        console.log('[vobiz] Unexpected inbound stop frame; closing the socket.');
        try { this.ws.close(); } catch { /* already closing */ }
        break;

      default:
        if (msg.event) console.log(`[vobiz] Unhandled event: ${msg.event}`);
        break;
    }
  }

  handleTwilioMessage(msg) {
    switch (msg.event) {
      case 'connected':
        break;

      case 'start':
        // Twilio <Stream> sends no streamId; the socket itself is the stream.
        this.callSid = msg.start?.callSid || this.callId;
        console.log(`[twilio] Stream started: callSid=${this.callSid}, tracks=${msg.start?.tracks || 'unknown'}`);
        break;

      case 'media':
        // Twilio nests the payload under `stream`, not `media`. The old handler
        // read msg.media.payload, so every inbound frame was silently dropped
        // and the caller was never heard.
        if (msg.stream?.payload) {
          const rawChunk = Buffer.from(msg.stream.payload, 'base64');
          this.processInboundAudioChunk(rawChunk);
        } else if (msg.media?.payload) {
          this.processInboundAudioChunk(Buffer.from(msg.media.payload, 'base64'));
        }
        break;

      case 'mark':
        this.isAiSpeaking = false;
        break;

      case 'dtmf':
        if (msg.dtmf?.digit) this.handleDtmf(msg.dtmf.digit);
        break;

      case 'stop':
        console.log('[twilio] Call stream stop event received');
        this.finishCall('completed');
        break;

      default:
        break;
    }
  }

  /**
   * DTMF while the AI is talking: treat it as an interrupt, the same as speech.
   * Customers press keys to cut in, and without this the AI keeps talking over
   * them.
   */
  handleDtmf(digit) {
    this.addTranscript('system', `[DTMF ${digit}]`);
    if (this.engine?.handleDtmf) {
      try { this.engine.handleDtmf(digit); } catch {}
    }
    if (!this.isAiSpeaking) return;
    if (Date.now() - (this.lastSpeakStart || 0) < 800) return;
    console.log(`[mediaStream] Barge-in via DTMF ${digit}`);
    this.clearAudioBuffer();
    this.ignoreUntil = Date.now() + 100;
    this.silenceTimer && clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  /**
   * Decode one inbound media frame to signed 16-bit linear samples.
   *
   * The docs require decoding every media.payload with the encoding and sample
   * rate from start.mediaFormat. This previously always assumed G.711 mu-law at
   * 8 kHz, which only held because the answer XML pinned contentType; switch to
   * L16 and the VAD measured pure noise and no turn was ever detected.
   */
  decodeInbound(chunk) {
    const encoding = this.mediaFormat?.encoding || 'mulaw';
    const rate = this.mediaFormat?.sampleRate || 8000;

    if (encoding === 'l16' || encoding === 'pcm16' || encoding === 'linear16') {
      const count = Math.floor(chunk.length / 2);
      const out = new Int16Array(count);
      for (let i = 0; i < count; i++) out[i] = chunk.readInt16LE(i * 2);
      return { samples: out, sampleRate: rate, bitsPerSample: 16 };
    }

    // G.711 mu-law, the telephony default.
    const out = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) out[i] = mulawToLinear(chunk[i]);
    return { samples: out, sampleRate: rate, bitsPerSample: 8 };
  }

  processInboundAudioChunk(chunk) {
    if (!chunk || !chunk.length) return;

    // Always record the customer's incoming audio for the mixed call recording
    this.recordTrack('customer', chunk);

    // If an engine adapter is active, delegate audio processing directly to it
    if (this.engine) {
      this.engine.handleInboundAudio(chunk);
      return;
    }

    if (!this.engine && !this.finished) {
      if (!this._pendingAudioInitBuffer) this._pendingAudioInitBuffer = [];
      if (this._pendingAudioInitBuffer.length < 50) this._pendingAudioInitBuffer.push(chunk);
      return;
    }

    const { samples } = this.decodeInbound(chunk);

    // 1. Linear PCM Energy Calculation (VAD)
    // Signed 16-bit linear PCM [-32768, 32767], whatever the carrier negotiated.
    const n = samples.length;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / n);
    this.diag.mediaChunks++;
    const now = Date.now();

    // Adaptively track baseline ambient noise floor only when line is quiet (rms < 60)
    // Capped between 15 and 50 RMS.
    if (rms < 60) {
      this.noiseFloor = this.noiseFloor === 0
        ? rms
        : Math.min(50, Math.max(15, this.noiseFloor * 0.95 + rms * 0.05));
    }

    // A frame is genuine human speech if RMS exceeds speech threshold.
    // Reverb / echo suppression: for 400ms immediately following AI playback,
    // require a higher threshold to avoid tail-end acoustic reflection opening a turn.
    const postPlaybackCooldown = now < (this.playbackEndTime || 0) + 400;
    const baseFloor = this.noiseFloor || 30;
    const speechThreshold = postPlaybackCooldown
      ? Math.max(105, baseFloor + 40)
      : Math.max(70, baseFloor + 22);

    const isSpeechLike = rms >= speechThreshold;
    this.speechRun = isSpeechLike ? (this.speechRun || 0) + 1 : 0;
    const sustainedSpeech = this.speechRun >= 3;

    // Is the AI actively playing out audio on the caller's phone?
    const isAiPlaying = (this.isAiSpeaking || now < (this.playbackEndTime || 0)) && !this._bargedIn;

    if (now - this.diag.lastDiagTs > 3000) {
      this.diag.lastDiagTs = now;
      console.log(
        `[vobiz:diag] mediaChunks=${this.diag.mediaChunks} rms=${rms.toFixed(1)} noiseFloor=${(this.noiseFloor || 0).toFixed(1)} ` +
        `speech=${isSpeechLike ? 'Y' : 'n'}${sustainedSpeech ? '+' : ''} run=${this.speechRun} isUserSpeaking=${this.isUserSpeaking} ` +
        `isAiPlaying=${isAiPlaying} isProcessingSpeech=${this.isProcessingSpeech} ` +
        `buf=${this.audioBuffer.length} (${this.activeUtteranceBytes}b)`
      );
    }

    // --- Case 1: AI is speaking / playing out audio ---
    if (isAiPlaying) {
      const speakElapsed = now - (this.lastSpeakStart || 0);
       const minSpeakElapsed = 0;
       const bargeThreshold = Math.max(120, baseFloor + 60);

       // Real human interruption over speakerphone/handset
       if (speakElapsed >= minSpeakElapsed && rms >= bargeThreshold && this.speechRun >= 3) {
        if (!this._bargeInLogged) {
          this._bargeInLogged = true;
          console.log(`[mediaStream] Barge-in: caller interrupted AI (rms=${rms.toFixed(0)}, elapsed=${speakElapsed}ms).`);
        }
        this._bargedIn = true;
        this.lastBargeInAt = now;
        this.clearAudioBuffer();
        this.isAiSpeaking = false;
        this.playbackEndTime = 0;
        this.isUserSpeaking = true;
        this.utteranceStartedAt = now;
        this.lastSpeechTs = now;
        this.quietFrames = 0;
        this.voicedFrames = 1;
        this.audioBuffer = [chunk];
        this.activeUtteranceBytes = chunk.length;
        this._bargeCooldownEnd = now + 500; // 500ms cooldown after barge-in
        return;
      }

      // If not barged in, inbound audio while AI is playing is speaker acoustic echo:
      return;
    }

    // --- Case 2: Customer turn (AI is quiet) ---

    if (!this.isUserSpeaking) {
      // Idle / waiting for caller to speak: maintain small ring buffer for consonant onset
      if (!this.preSpeechBuffer) this.preSpeechBuffer = [];
      this.preSpeechBuffer.push(chunk);
      if (this.preSpeechBuffer.length > 20) this.preSpeechBuffer.shift();

      if (isSpeechLike && sustainedSpeech && !this.isProcessingSpeech) {
        if (this.exitTimer) {
          clearTimeout(this.exitTimer);
          this.exitTimer = null;
          console.log('[mediaStream] Caller resumed speaking; aborted pending call exit timer.');
        }
        // Voice detected! Start utterance and include the pre-speech buffer
        this.isUserSpeaking = true;
        this.utteranceStartedAt = now;
        this.lastSpeechTs = now;
        this.quietFrames = 0;
        this.voicedFrames = this.speechRun;
        this.audioBuffer = [...this.preSpeechBuffer];
        this.activeUtteranceBytes = this.audioBuffer.reduce((acc, c) => acc + c.length, 0);
        this.preSpeechBuffer = [];
      }
    } else {
      // Actively recording caller's voice utterance
      this.audioBuffer.push(chunk);
      this.activeUtteranceBytes += chunk.length;

      if (isSpeechLike) {
        this.voicedFrames = (this.voicedFrames || 0) + 1;
        this.lastSpeechTs = now;
        this.quietFrames = 0;
      } else {
        this.quietFrames = (this.quietFrames || 0) + 1;
      }

      const pauseMs = now - (this.lastSpeechTs || now);
      const utteranceMs = now - (this.utteranceStartedAt || now);

      // Natural conversational endpointing:
      // Allow 750ms pause (14 quiet frames) so customer can pause between words/clauses without getting cut off
      const isTurnComplete = this.activeUtteranceBytes >= 1600 && (
        (pauseMs >= 750 && this.quietFrames >= 14) ||
        (utteranceMs >= 4000 && pauseMs >= 500) ||
        this.activeUtteranceBytes >= 48000
      );

      if (isTurnComplete && !this.isProcessingSpeech) {
        this.isUserSpeaking = false;
        const voiced = this.voicedFrames || 0;
        this.voicedFrames = 0;
        this.quietFrames = 0;

        // Discard phantom noise / breath / rustle:
        // A genuine Telugu word has at least 6 voiced frames (~120ms of real vocal energy).
        // If voiced < 6, this was just a breath, rustle, or acoustic blip!
        if (voiced < 6) {
          this.audioBuffer = [];
          this.activeUtteranceBytes = 0;
          return;
        }

        this.handleSpeechUtterance();
        return;
      }
    }
  }

  /**
   * Append a mu-law frame to one side of the call recording.
   * Timestamped so mixTracksToWav can line the two sides up on one sample grid.
   */
  recordTrack(side, chunk, explicitTime = null) {
    if (!chunk || !chunk.length) return;
    const isCustomer = side === 'customer';
    const track = isCustomer ? this.recCustomer : this.recAi;
    const bytes = isCustomer ? this.recCustomerBytes : this.recAiBytes;
    if (bytes >= MAX_RECORDING_TRACK_BYTES) return;
    const t = explicitTime !== null ? explicitTime : (Date.now() - this.startTime);
    track.push({ t, buf: Buffer.from(chunk) });
    if (isCustomer) this.recCustomerBytes = bytes + chunk.length;
    else this.recAiBytes = bytes + chunk.length;
  }

  clearAudioBuffer() {
    this.isAiSpeaking = false;
    this.isUserSpeaking = false;
    this.audioBuffer = [];
    this.activeUtteranceBytes = 0;
    this.aiPlaybackCursor = Date.now() - this.startTime;
    if (this.engine?.interrupt) {
      try {
        this.engine.interrupt();
      } catch {}
    }
    // Playback is about to be cut, so no playedStream will ever arrive for the
    // pending checkpoint. Release speak() instead of letting it time out.
    if (this._pendingCheckpoint) {
      const resolve = this._pendingCheckpoint;
      this._pendingCheckpoint = null;
      resolve();
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.exitTimer && !this.isClosing) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    if (this.provider === 'vobiz') {
      this.send({
        event: 'clearAudio',
        streamId: this.streamSid, // docs: echo the start streamId back
      });
    } else {
      // Twilio <Stream> drops everything queued with an explicit clear; there
      // is no streamId to echo.
      this.send({ event: 'clear' });
    }
  }

  /**
   * Clear the isProcessingSpeech flag and immediately process any audio the
   * caller queued while the AI was mid-turn (the ~1-min delay fix).
   */
  _finishProcessing() {
    this.isProcessingSpeech = false;
    if (this.pendingAudio && this.pendingAudio.length >= 2000) {
      const queued = this.pendingAudio;
      this.pendingAudio = null;
      console.log(`[mediaStream] Processing queued caller audio (${queued.length} bytes) from pending turn.`);
      setImmediate(() => this.handleSpeechUtterance(queued));
    } else {
      this.pendingAudio = null;
    }
  }

  async handleSpeechUtterance(overrideAudio = null) {
    if (this.finished) return;
    if (this.exitTimer && !this.isClosing) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    this.isProcessingSpeech = true;
    try {
    const fullAudio = overrideAudio || Buffer.concat(this.audioBuffer);
    this.audioBuffer = [];
    this.activeUtteranceBytes = 0;

    let userText = '';
    const languageCode = (this.employee?.language_code || 'te').toLowerCase();
    // Groq's Whisper endpoint expects a bare ISO-639-1 code; a locale such as
    // "te-IN" is not in its documented language enum.
    const isoLang = languageCode.split('-')[0];
    // createSimpleWavHeader wraps the mu-law frames in a WAV container with
    // format tag 7 (mu-law), which Groq's documented file formats accept.
    const wavBuffer = createSimpleWavHeader(fullAudio, 8000, 1, 8);

    let keyterms = [];
    try {
      if (Array.isArray(this.employee?.custom_keyterms)) {
        keyterms = this.employee.custom_keyterms;
      } else if (typeof this.employee?.custom_keyterms === 'string') {
        keyterms = JSON.parse(this.employee.custom_keyterms);
      } else if (this.employee?.livekit_metadata?.custom_keyterms) {
        keyterms = this.employee.livekit_metadata.custom_keyterms;
      }
    } catch {}

    // STT pipeline: Deepgram Nova-3 (with domain keyterm boosting) -> Sarvam Saaras v3 -> Groq Whisper
    const attempts = [
      ...(this.deepgram.isConfigured() ? [{
        name: 'deepgram-nova3',
        run: () => this.deepgram.transcribe(wavBuffer, {
          language: isoLang,
          model: 'nova-3',
          keyterms,
        }),
      }] : []),
      { name: 'sarvam', run: () => this.sarvam.transcribe(wavBuffer, { language: this.employee?.language_code || 'te-IN' }) },
      {
        name: 'groq-whisper',
        run: async () => {
          const { GroqProvider } = require('../providers/ai/groq');
          if (!process.env.GROQ_API_KEY) throw new AppError('Groq key not set', 500, 'GROQ_NOT_CONFIGURED');
          const res = await new GroqProvider().transcribe(wavBuffer, {
            language: isoLang,
            filename: 'call.wav',
            contentType: 'audio/wav',
          });
          return { transcript: res.text };
        },
      },
    ];

    for (const attempt of attempts) {
      try {
        const stt = await attempt.run();
        userText = (stt.transcript || '').trim();
        if (userText) {
          if (attempt.name !== attempts[0].name) {
            console.log(`[mediaStream] STT recovered via ${attempt.name}: "${userText.slice(0, 60)}"`);
          }
          break;
        }
      } catch (sttErr) {
        console.warn(`[mediaStream] STT ${attempt.name} unavailable: ${sttErr.message}`);
      }
    }

    if (!userText || userText.length < 2) {
      console.warn(`[vobiz:diag] STT returned nothing (bytes=${fullAudio.length}) -> userText="${userText}"`);
      this._finishProcessing();
      return;
    }

    // If call is ALREADY in closing state (farewell was delivered):
    // Check if the caller is just acknowledging ("ఓకే", "సరే", "థాంక్స్", "బాయ్", "హా")
    // or if they explicitly asked to stop and continue asking questions ("ఆగండి", "వెయిట్")
    if (this.isClosing) {
      const normCheck = userText.toLowerCase().replace(/[.,!?;:()]/g, ' ').replace(/\s+/g, ' ').trim();
      const waitWords = ['ఆగండి', 'ఆగు', 'వెయిట్', 'wait', 'ఒక్క నిమిషం', 'ఒక్క ప్రశ్న', 'ఇంకో ప్రశ్న', 'one question', 'one second'];
      const isCancellation = waitWords.some((w) => normCheck.includes(w));
      if (!isCancellation) {
        console.log(`[mediaStream] Call ${this.callId} already in closing state. Caller gave post-farewell ack ("${userText}"). Ending call cleanly.`);
        this.addTranscript('customer', userText);
        this.finishCall('completed');
        this._finishProcessing();
        return;
      } else {
        console.log(`[mediaStream] Customer explicitly requested to continue call ("${userText}"). Resetting closing state.`);
        this.isClosing = false;
        if (this.exitTimer) {
          clearTimeout(this.exitTimer);
          this.exitTimer = null;
        }
      }
    }

    // 2. Is this actually the AI's own voice coming back (self-echo)?
    // Only discard if text is >= 75% identical echo. Never discard real customer answers.
    if (this.recentAiSpeech.length) {
      const selfEcho = Math.max(...this.recentAiSpeech.map((t) => echoTextScore(userText, t)));
      if (selfEcho >= 0.75) {
        console.log(
          `[mediaStream] Discarding self-echo utterance (${(selfEcho * 100).toFixed(0)}% match with our own last reply): "${userText.slice(0, 60)}"`
        );
        this._finishProcessing();
        return;
      }
    }

    // --- English → Telugu auto-translation ----------------------------------
    // If the employee is a Telugu caller but the user spoke in English,
    // translate via Groq so the LLM always receives Telugu input and responds
    // in Telugu. Short back-channels ("ok", "yes", "no") are kept as-is.
    const employeeLang = (this.employee?.language_code || 'te').toLowerCase();
    if (employeeLang.startsWith('te') && isEnglishText(userText)) {
      try {
        const { GroqProvider } = require('../providers/ai/groq');
        const groqTranslator = new GroqProvider();
        const translationRes = await groqTranslator.generateResponse([
          { role: 'user', content: userText }
        ], {
          systemPrompt: 'You are a translator. Translate the following English text to natural spoken Telugu script (తెలుగు). Return ONLY the Telugu translation, nothing else.',
          temperature: 0.1,
          maxTokens: 300,
        });
        const translated = (translationRes.text || '').trim();
        if (translated && translated.length > 1) {
          console.log(`[mediaStream] English→Telugu: "${userText}" → "${translated}"`);
          userText = translated;
        }
      } catch (translErr) {
        console.warn(`[mediaStream] English→Telugu translation failed: ${translErr.message}. Using original text.`);
      }
    }
    // -------------------------------------------------------------------------

    console.log(`[mediaStream] User (${this.provider}): "${userText}"`);
    this.addTranscript('customer', userText);
    this.messages.push({ role: 'user', content: userText });
    realtime.emit(this.orgId, 'call.user_started', { callId: this.callId, callDbId: this.callDbId });

    // --- Blood group auto-detect -------------------------------------------
    const bg = this.detectBloodGroup(userText);
    if (bg) {
      this.bloodGroup = bg;
      this.addTranscript('system', `[Blood group detected: ${bg}]`);
      console.log(`[mediaStream] Blood group ${bg} captured (emp=${this.employee?.name})`);
      realtime.emit(this.orgId, 'call.bloodGroup', { callId: this.callId, callDbId: this.callDbId, bloodGroup: bg });
    }

    // Build system prompt dynamically based on the active employee, company, role, and specific lead context
    const baseSystemPrompt = buildSystemPrompt(
      this.employee || { name: 'Assistant' },
      { name: this.employee?.company || 'our company' },
      this.employeeKnowledge,
      this.lead
    );

    const leadName = (this.lead?.name || '').trim();
    const leadPurpose = (this.lead?.purpose || '').trim();
    const lang = (this.employee?.language_code || 'te').toLowerCase();
    const leadHonorific = leadName ? (
      lang.startsWith('hi') ? `${leadName} जी` :
      lang.startsWith('en') ? leadName :
      `${leadName} గారు`
    ) : '';

    const lastAiMsg = (this.messages.slice().reverse().find((m) => m.role === 'assistant')?.content || '').trim();

    const systemPrompt = `${baseSystemPrompt}
Instructions for live phone conversation (REAL HUMAN TELEPHONE AGENT):
- Speak strictly as a genuine, warm human telephony advisor (${this.employee?.name || 'Advisor'}). NEVER sound like a computer or say you are an AI.
- Reply in 1 or 2 concise, polite, natural conversational sentences in ${this.employee?.language || 'Telugu'} with respect (${leadHonorific || 'అండి'}).
- Use natural active listening bridges before speaking (e.g. "అవునా అండి!", "ఓహ్ అర్థమైందండి...", "ఖచ్చితంగా అండి!").
- Insert natural commas (,) between spoken clauses so your voice breathes naturally.
- Maximum 15-20 words per response. Keep answers brief and ask at most ONE simple question, then pause for the caller.
${leadName ? `- Always refer to and address the caller respectfully as "${leadHonorific}".` : ''}
${leadPurpose ? `- Focus the conversation directly on their inquiry: "${leadPurpose}". Ask clear qualifying questions to understand their needs regarding "${leadPurpose}".` : ''}
- CRITICAL ANTI-REPETITION RULES:
  * NEVER repeat your greeting, self-introduction ("నమస్కారం! నేను ..."), or company pitch once the call is in progress.
  * NEVER repeat questions or statements you have already made.
  ${lastAiMsg ? `* You just said: "${lastAiMsg.slice(0, 90)}...". Absolutely do NOT repeat or rephrase this exact sentence!` : ''}
  * If the caller says "ఓకే", "సరే", "హా", "అవును", "ఓకే ఓకే" after you invited them to a demo/session or asked for confirmation, DO NOT ask them if they will attend again. Confirm their registration happily, tell them details/link are being sent on WhatsApp, and conclude the call warmly.
- If the customer says "థాంక్యూ", "థాంక్స్", "ధన్యవాదాలు", "ఏం లేదు", "లేదు", "చాలు", or confirms next step, give a warm, polite 1-sentence farewell thanking them and stating details will be sent on WhatsApp. Do NOT ask any more questions.
- Never use markdown symbols (*, _, #, bullet points, numbered lists) or line breaks.
- Always finish your sentence completely.`;

    const recentAssistantReplies = this.messages
      .filter((m) => m.role === 'assistant')
      .slice(-4)
      .map((m) => String(m.content || '').trim())
      .filter(Boolean);
    if (recentAssistantReplies.length) {
      systemPrompt += `\nDo not repeat any of these previous replies: ${recentAssistantReplies.map((r) => `"${r.slice(0, 80)}"`).join('; ')}. Ask a new follow-up or move the conversation forward.`;
    }

    // Detect if customer explicitly requested to cut call OR answered negative/done to assistant question confirmation
    let isEndingCall = detectEndingIntent(userText, this.messages);

    let reply = '';
    try {
      const promptToUse = isEndingCall
        ? `${systemPrompt}\nThe customer has completed their inquiry and the call is ending. Give a warm, polite 1-sentence farewell in character (thank them and mention details/quote/link will be sent on WhatsApp). Do NOT ask any more questions.`
        : systemPrompt;

      const llmRes = await this.ai.generateResponse(this.messages.slice(-8), {
        systemPrompt: promptToUse,
        temperature: 0.35,
        maxTokens: 220,
        frequencyPenalty: 0.6,
        presencePenalty: 0.4,
        maxRetries: 1,
      });
      reply = (llmRes.text || '')
        .replace(/[*_#•-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Repetition / loop breaker safeguard: never reuse a reply we already gave.
      const priorAssistantReplies = this.messages
        .filter((m) => m.role === 'assistant')
        .map((m) => String(m.content || '').trim().toLowerCase())
        .filter(Boolean);
      const isRepeatedReply = priorAssistantReplies.some((prev) => {
        const a = prev;
        const b = reply.trim().toLowerCase();
        if (!a || !b) return false;
        if (a === b) return true;
        if (b.length > 20 && a.includes(b.slice(0, 25))) return true;
        if (a.length > 20 && b.includes(a.slice(0, 25))) return true;
        return false;
      });
      if (isRepeatedReply) {
        console.warn('[mediaStream] Repetition loop detected! Breaking loop with forward progress.');
        if (reply.length > 40) {
          reply = `${leadHonorific || 'అండి'}, చాలా సంతోషం! మీ డెమో వివరాలు మరియు లింక్ వెంటనే మీ వాట్సాప్‌కి పంపిస్తాము, ధన్యవాదాలు!`;
          isEndingCall = true;
        } else {
          reply = `${leadHonorific || 'అండి'}, చెప్పండి, నేను వింటున్నాను.`;
        }
      }
    } catch (llmErr) {
      console.warn('[mediaStream] LLM error:', llmErr.message);
    }

    if (!reply) {
      this._finishProcessing();
      return;
    }

    this.messages.push({ role: 'assistant', content: reply });
    this.addTranscript('ai', reply);

    // Synthesize voice and stream back
    await this.speak(reply);

    if (isEndingCall) {
      this.isClosing = true;
      // Ensure caller hears the ENTIRE farewell audio on their phone before hanging up.
      // this.playbackEndTime is calculated in speak() as (playbackStartTime + spokenMs + 100).
      const remainingPlaybackMs = Math.max(0, (this.playbackEndTime || Date.now()) - Date.now());
      // Wait for audio to finish playing on phone + 1500ms grace pause for line flush
      const waitMs = Math.max(3500, remainingPlaybackMs + 1500);
      console.log(`[mediaStream] Farewell audio streaming to carrier; waiting ${waitMs}ms (${remainingPlaybackMs}ms playback + 1500ms grace) so caller hears full audio.`);
      this.exitTimer = setTimeout(() => {
        this.exitTimer = null;
        console.log(`[mediaStream] Call ${this.callId} farewell audio finished playing. Ending call cleanly.`);
        this.finishCall('completed');
      }, waitMs);
    }
    this._finishProcessing();
    } finally {
      this.isProcessingSpeech = false;
      this.pendingAudio = null;
    }
  }

  /**
   * The provider this employee is actually configured to use.
   *
   * Cloned Sarvam voices only exist on Sarvam, so a stale or wrong
   * voice_provider must not send them to Cartesia; resolveVoiceProvider()
   * checks for that before honouring the declared provider.
   */
  resolveVoiceProvider() {
    const { resolveVoiceProvider } = require('../providers');
    try {
      return resolveVoiceProvider(this.employee?.voice || null, this.employee?.voice_provider || null);
    } catch (err) {
      console.warn('[mediaStream] voice provider resolution failed:', err.message);
      return this.cartesia;
    }
  }

  /**
   * Frame size for outbound audio.
   *
   * VoBiz and Twilio both want uniform frames, but for different reasons: VoBiz
   * plays silently on variable sizes, Twilio buffers on very small ones. 480
   * bytes is 60ms at 8kHz, which is what this path has always used.
   */
  get audioFrameBytes() {
    return 480;
  }

  resolveVoiceProviderName() {
    return this.resolveVoiceProvider()?.constructor?.name || 'unknown';
  }

  /**
   * The carrier finished playing an utterance we checkpointed.
   *
   * Replaces the estimated end-of-playback time with a measured one, which is
   * what the barge-in guard and the farewell-wait both depend on. If the
   * carrier never reports back, the existing estimate stands.
   */
  onPlaybackConfirmed() {
    this.playbackEndTime = Date.now();
    this.isAiSpeaking = false;
    this.bargeInFrames = 0;
    if (this._pendingCheckpoint) {
      const resolve = this._pendingCheckpoint;
      this._pendingCheckpoint = null;
      resolve();
    }
  }

  /**
   * Ask VoBiz to report when playback reaches the end of what we just sent.
   *
   * The `checkpoint` command is sent with the same streamId as playAudio; the
   * matching `playedStream` event comes back on the socket. The docs require a
   * `name` and state that playedStream echoes the name set on the matching
   * checkpoint - omitting it left the ack ambiguous. Resolution is bounded so a
   * carrier that never reports cannot stall the turn.
   */
  awaitPlaybackConfirmed(timeoutMs = 12000) {
    if (this.provider !== 'vobiz' || !this.streamSid) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._pendingCheckpoint = null;
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      if (timer.unref) timer.unref();
      this._pendingCheckpoint = () => done(true);
      this._pendingCheckpointName = this._nextCheckpointName();
      this.send({ event: 'checkpoint', streamId: this.streamSid, name: this._pendingCheckpointName });
    });
  }

  /** Monotonic, human-readable checkpoint label: response-1, response-2, ... */
  _nextCheckpointName() {
    this._checkpointSeq = (this._checkpointSeq || 0) + 1;
    return `response-${this._checkpointSeq}`;
  }

  async speak(text) {
    this.isAiSpeaking = true;
    this.lastSpeakStart = Date.now();
    this.playbackStartTime = null;
    realtime.emit(this.orgId, 'call.ai_started', { callId: this.callId, callDbId: this.callDbId });
    const nowRel = Date.now() - this.startTime;
    if (!this.aiPlaybackCursor || this.aiPlaybackCursor < nowRel) {
      this.aiPlaybackCursor = nowRel;
    }
    this.bargeInFrames = 0;
    this._bargeInLogged = false;  // reset per-utterance barge-in log flag
    this._bargedIn = false;       // cleared before every new utterance
    if (this.silenceTimer) { // cancel any pending utterance processing
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    const speakId = Math.random().toString(36).slice(2, 7);
    const ttsName = this.resolveVoiceProviderName();
    let pcmBytes = 0;
    console.log(`[mediaStream] SPEAK[${speakId}] START via ${ttsName} | ${text.length} chars, isAiSpeaking=${this.isAiSpeaking}, streamSid=${this.streamSid}`);
    try {
      const langCode = this.employee?.language_code || (
        this.employee?.language === 'Hindi' ? 'hi-IN' :
        this.employee?.language === 'English' ? 'en-IN' :
        this.employee?.language === 'Tamil' ? 'ta-IN' :
        this.employee?.language === 'Kannada' ? 'kn-IN' :
        this.employee?.language === 'Malayalam' ? 'ml-IN' :
        this.employee?.language === 'Marathi' ? 'mr-IN' : 'te-IN'
      );
      const iterator = this.resolveVoiceProvider().streamSynthesize(text, {
        voice: this.employee?.voice || undefined,
        language: langCode,
        speed: this.employee?.voice_speed || 1.0,
      });

      const FRAME = 480;
      let carry = Buffer.alloc(0);
      for await (const mulawChunk of iterator) {
        if (!this.isAiSpeaking || this._bargedIn) break;
        if (mulawChunk.length > 0) {
          pcmBytes += mulawChunk.length;
          const buffered = carry.length > 0 ? Buffer.concat([carry, mulawChunk]) : mulawChunk;
          const nFrames = Math.floor(buffered.length / FRAME);
          for (let i = 0; i < nFrames; i++) {
            if (!this.isAiSpeaking || this._bargedIn) break;
            const frame = buffered.subarray(i * FRAME, (i + 1) * FRAME);
            this.sendAudioFrame(frame);
          }
          carry = buffered.subarray(nFrames * FRAME);
          await sleep(2);
        }
      }
      if (carry.length > 0 && !this._bargedIn && this.isAiSpeaking) {
        pcmBytes += carry.length;
        this.sendAudioFrame(carry);
      }
      console.log(`[mediaStream] TTS[${speakId}] streamed ${pcmBytes} bytes for "${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"${this._bargedIn ? ' [INTERRUPTED]' : ''}`);
    } catch (err) {
      console.warn(`[mediaStream] TTS stream warning [${speakId}]:`, err.message);
    } finally {
      const spokenMs = Math.round(pcmBytes / 8);

      if (this._bargedIn) {
        this.isAiSpeaking = false;
        this.playbackEndTime = 0;
        this.aiPlaybackCursor = Date.now() - this.startTime;
        console.log(`[mediaStream] SPEAK[${speakId}] DONE (barged-in after ${spokenMs}ms); listening immediately`);
      } else {
        this.isAiSpeaking = false;
        // Audio playback on phone starts at playbackStartTime and completes spokenMs + 100ms later
        const expectedEnd = (this.playbackStartTime || Date.now()) + spokenMs + 100;
        this.playbackEndTime = Math.max(Date.now(), expectedEnd);
        console.log(`[mediaStream] SPEAK[${speakId}] Streamed to carrier; playing on phone for ${spokenMs}ms`);

        // Ask the carrier when playback actually finished. When it answers, the
        // estimate above is replaced by a measured value, so the next barge-in
        // check and the farewell wait both start from the real end of audio.
        // The wait is bounded tightly and released early by clearAudio, because
        // the caller must be able to start their next turn immediately.
        if (this.provider === 'vobiz' && !this._bargedIn) {
           const confirmed = await this.awaitPlaybackConfirmed(
             Math.min(8000, spokenMs + 2000)
           );
           if (this._bargedIn) {
             this.isAiSpeaking = false;
             this.playbackEndTime = 0;
             console.log(`[mediaStream] SPEAK[${speakId}] interrupted during playback wait; listening immediately`);
           } else if (confirmed) {
             const actual = Date.now() - (this.playbackStartTime || Date.now());
             console.log(
               `[mediaStream] SPEAK[${speakId}] carrier confirmed playback after ${actual}ms (estimated ${spokenMs}ms)`
             );
           } else {
             console.log(`[mediaStream] SPEAK[${speakId}] no playedStream confirmation; keeping the ${spokenMs}ms estimate`);
           }
        }
      }
    }
  }

  sendAudioFrame(buffer) {
    if (!this.playbackStartTime) {
      this.playbackStartTime = Date.now();
    }
    const nowRel = Date.now() - this.startTime;
    if (!this.aiPlaybackCursor || this.aiPlaybackCursor < nowRel) {
      this.aiPlaybackCursor = nowRel;
    }
    const frameTime = this.aiPlaybackCursor;
    const frameDurationMs = (buffer.length / 8000) * 1000;
    this.aiPlaybackCursor += frameDurationMs;

    // Capture what the caller actually heard, positioned accurately on the real playback timeline.
    this.recordTrack('ai', buffer, frameTime);

    const payload = buffer.toString('base64');
    if (this.provider === 'vobiz') {
      this.send({
        event: 'playAudio',
        streamId: this.streamSid, // docs: echo the start streamId back for playback events
        media: {
          payload,
          contentType: 'audio/x-mulaw',
          sampleRate: 8000,
        },
      });
    } else {
      // Twilio <Stream> uses `stream`, not `streamSid`, and takes no streamId.
      // mediaStreamService previously sent the vobiz/twilio-media-stream shape,
      // which Twilio ignores - the call was silent.
      this.send({
        event: 'media',
        stream: { payload },
      });
    }
  }

  send(data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  addTranscript(speaker, text) {
    const ts = Math.round((Date.now() - this.startTime) / 1000);
    this.transcript.push({ speaker, text, ts });

    // Remember what we said so the STT output can be checked against it. A phone
    // speaker distorts our own voice enough that waveform correlation sometimes
    // misses, and when it does the AI ends up transcribing and then answering
    // itself - the "it just speaks to itself and never listens" symptom.
    if (speaker === 'ai' && text && text.length > 3) {
      this.recentAiSpeech.push(text);
      if (this.recentAiSpeech.length > 4) this.recentAiSpeech.shift();
    }

    // Broadcast live transcript to dashboard
    realtime.emit(this.orgId, 'call.transcript', {
      callId: this.callId,
      callDbId: this.callDbId,
      speaker,
      text,
      ts,
    });
  }

  // Blood-group detection (Latin + Telugu). Runs on every caller utterance so
  // healthcare employees (e.g. Kavya — blood test booking) capture the caller's
  // blood group as a structured field on the calls row:
  //   Latin :  A+  B+  O+  AB+  O-  AB-
  //   Telugu:  ఎ ప్లస్ / బి ప్లస్ / ఓ ప్లస్ / ఎబి ప్లస్ / ఓ మైనస్ / ఎబి మైనస్
  // Also tolerates the caller reading it back as "ఎక్కువ ప్లస్" style phrasing.
  detectBloodGroup(text = '') {
    if (!text) return null;
    const t = text.replace(/\s+/g, ' ').trim().toLowerCase();
    // Normalize Telugu spoken forms into a canonical letter+sign token first.
    const teluguMap = {
      'ఎ ప్లస్': 'A+', 'ఏ ప్లస్': 'A+', 'ఎ ప్లస్ గ్రూప్': 'A+', 'ఎ ప్లస్ బ్లడ్': 'A+',
      'బి ప్లస్': 'B+', 'బీ ప్లస్': 'B+', 'బి ప్లస్ గ్రూప్': 'B+',
      'ఓ ప్లస్': 'O+', 'ఒ ప్లస్': 'O+', 'ఓ ప్లస్ గ్రూప్': 'O+',
      'ఎబి ప్లస్': 'AB+', 'ఎబీ ప్లస్': 'AB+', 'ఎబి ప్లస్ గ్రూప్': 'AB+',
      'ఓ మైనస్': 'O-', 'ఒ మైనస్': 'O-', 'ఓ నెగటివ్': 'O-',
      'ఎబి మైనస్': 'AB-', 'ఎబీ మైనస్': 'AB-', 'ఎబి నెగటివ్': 'AB-',
    };
    for (const [pat, norm] of Object.entries(teluguMap)) {
      if (t.includes(pat)) return norm;
    }
    // Latin pattern: letter+optional letter optional +/- (word boundary safe).
    const m = t.match(/\b(ab|a|b|o)(\+|\-)\b/);
    if (m) return `${m[1].toUpperCase()}${m[2]}`;
    return null;
  }

  /**
   * Mix the captured customer + AI audio into a WAV, store it, and link it to the
   * call. Never throws — a missing recording must not fail the rest of the
   * post-call pipeline (credits, transcripts, follow-up email).
   */
  async persistRecording(duration) {
    try {
      if (!this.callDbId) return null;

      const existing = await queryOne(
        'SELECT recording_url FROM calls WHERE id = ?',
        [this.callDbId]
      );
      if (existing?.recording_url) {
        console.log(`[mediaStream] Call ${this.callId} already has a carrier recording; keeping it.`);
        return existing.recording_url;
      }

      // Diagnostic: log track sizes so recording failures are visible in logs.
      console.log(
        `[mediaStream] Mixing recording for ${this.callId}: ` +
        `customer=${this.recCustomer.length} frames (${this.recCustomerBytes}B), ` +
        `ai=${this.recAi.length} frames (${this.recAiBytes}B)`
      );

      const mixed = mixTracksToWav([this.recCustomer, this.recAi]);
      if (!mixed) {
        console.warn(`[mediaStream] No audio captured for ${this.callId} (both tracks empty); recording skipped.`);
        return null;
      }

      const url = await saveRecordingWav(this.callId, mixed.wav);
      if (!url) return null;

      const recDuration = Math.max(
        1,
        Math.round(mixed.durationSec) || duration || 0
      );
      await update('UPDATE calls SET recording_url = ? WHERE id = ?', [url, this.callDbId]);
      await insert(
        'INSERT INTO call_recordings (call_id, url, duration, size_bytes) VALUES (?,?,?,?)',
        [this.callDbId, url, recDuration, mixed.wav.length]
      ).catch(() => {});

      console.log(
        `[mediaStream] Saved ${recDuration}s recording for ${this.callId} -> ${url} ` +
        `(${(mixed.wav.length / 1024).toFixed(0)} KB, customer=${this.recCustomer.length} frames, ai=${this.recAi.length} frames)`
      );
      realtime.emit(this.orgId, 'call.recording', {
        callId: this.callId,
        callDbId: this.callDbId,
        recordingUrl: url,
        duration: recDuration,
      });
      return url;
    } catch (err) {
      console.warn('[mediaStream] Recording persist failed:', err.message);
      return null;
    }
  }

  /**
   * Scores a finished call and writes the verdict to calls + call_outcomes.
   *
   * Mirrors what the telephony webhook and callService do, so every call path
   * produces the same columns. Without this the media-stream path billed the
   * customer and recorded the audio but left outcome NULL, and the employee
   * dashboard - which derives Qualified, Hot leads and the outcome breakdown from
   * that one column - showed zeros for a call that had genuinely happened.
   *
   * @returns {Promise<{outcome: string, summary?: string, nextAction?: string}|null>}
   */
  async analyzeCompletedCall(callRow, duration, status) {
    if (!this.callDbId) return null;

    // A call that never connected still gets a truthful terminal outcome so the
    // breakdown reflects reality instead of quietly omitting the call.
    if (status !== 'completed') {
      const terminal = ['failed', 'busy', 'no_answer', 'wrong_number'].includes(status) ? status : 'failed';
      try {
        await update('UPDATE calls SET outcome = ? WHERE id = ?', [terminal, this.callDbId]);
        await insert(
          'INSERT INTO call_outcomes (call_id, outcome, confidence, reason, next_action) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE outcome=VALUES(outcome)',
          [this.callDbId, terminal, 1, `Call ${status}.`, null]
        );
      } catch (err) {
        console.warn(`[mediaStream] Could not record terminal outcome for ${this.callId}:`, err.message);
      }
      return { outcome: terminal };
    }

    const rows = (this.transcript || [])
      .filter((t) => t && t.text)
      .map((t) => ({ speaker: t.speaker, text: t.text }));

    // Fewer than two exchanges is not a conversation, and asking the LLM to score
    // it only produces a confident guess.
    if (rows.length < 2) {
      console.warn(`[mediaStream] Not scoring ${this.callId}: only ${rows.length} transcript line(s).`);
      return null;
    }

    try {
      const ai = getAIProvider();
      const analysis = await ai.analyzeCall(rows, this.employee);
      const outcome = analysis.outcome || 'follow_up';

      await update(
        `UPDATE calls SET sentiment=?, intent=?, summary=?, outcome=?, outcome_confidence=?, outcome_reason=?, next_action=? WHERE id=?`,
        [
          analysis.sentiment || null,
          analysis.intent || null,
          analysis.summary || null,
          outcome,
          analysis.outcomeConfidence ?? null,
          analysis.outcomeReason || null,
          analysis.nextAction || null,
          this.callDbId,
        ]
      );

      await insert(
        'INSERT INTO call_outcomes (call_id, outcome, confidence, reason, next_action) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE outcome=VALUES(outcome), confidence=VALUES(confidence), reason=VALUES(reason), next_action=VALUES(next_action)',
        [
          this.callDbId,
          outcome,
          analysis.outcomeConfidence || 0,
          analysis.outcomeReason || null,
          analysis.nextAction || null,
        ]
      );

      // Mirror the lead-status mapping callService uses, so a lead reached via a
      // live streamed call lands in the same funnel as any other call.
      if (callRow?.lead_id) {
        const fields = { status: 'contacted', outcome };
        if (outcome === 'interested') fields.status = 'interested';
        if (outcome === 'converted') fields.status = 'converted';
        if (outcome === 'not_interested') fields.status = 'not_interested';
        if (outcome === 'callback') fields.status = 'callback_requested';
        await update(
          'UPDATE leads SET status = ?, outcome = ?, last_call_id = COALESCE(last_call_id, ?), employee_id = COALESCE(employee_id, ?) WHERE id = ?',
          [fields.status, outcome, this.callDbId, callRow.employee_id, callRow.lead_id]
        ).catch(() => {});
      }

      if (this.orgId) {
        realtime.emit(this.orgId, 'call.analyzed', {
          callId: this.callId,
          callDbId: this.callDbId,
          outcome,
          sentiment: analysis.sentiment,
          summary: analysis.summary,
        });
      }
      console.log(`[mediaStream] Analysis done for ${this.callId}: ${outcome} (${analysis.sentiment})`);
      return { outcome, summary: analysis.summary, nextAction: analysis.nextAction };
    } catch (err) {
      // A missing verdict must never block the rest of finishCall (recording,
      // billing, transcript). Record why, and move on.
      console.warn(`[mediaStream] Post-call analysis failed for ${this.callId}:`, err.message);
      return null;
    }
  }

  async finishCall(status = 'completed') {
    // finishCall is reachable from the VoBiz 'stop' event AND the socket 'close'
    // handler, so the carrier fires it twice per call. Guard so the recording is
    // only written once (a second pass would duplicate the call_recordings row).
    if (this.finished) return;
    this.finished = true;
    if (this.exitTimer) {
      clearTimeout(this.exitTimer);
      this.exitTimer = null;
    }
    if (this.engine) {
      try {
        await this.engine.close();
      } catch (err) {
        console.warn(`[mediaStream] Engine close warning: ${err.message}`);
      }
    }

    const duration = Math.max(5, Math.round((Date.now() - this.startTime) / 1000));
    console.log(`[mediaStream] Call ${this.callId} finished. Duration: ${duration}s, Status: ${status}`);

    try {
      if (this.callDbId) {
        let cost = 0;
        let rate = 0;
        try {
          cost = typeof calculateCallCost === 'function' ? calculateCallCost({ duration, status, employee: this.employee }) : 0;
          rate = typeof getVoicePerMinuteRate === 'function' ? getVoicePerMinuteRate(this.employee) : 0;
        } catch (cErr) {
          console.warn('[mediaStream] calculateCallCost safe fallback:', cErr.message);
        }

        // The transcript lives only in memory until here, so it is persisted BEFORE
        // the row is marked complete and debited. The previous order committed
        // "completed" first and wrote the lines afterwards, which meant a crash
        // in between left a billed call with a permanently empty transcript.
        // The insert is guarded per line so one bad row cannot lose the rest.
        let savedLines = 0;
        for (const item of this.transcript) {
          try {
            await insert('INSERT INTO call_transcripts (call_id, speaker, text, ts) VALUES (?,?,?,?)', [
              this.callDbId, item.speaker, item.text, item.ts || 0
            ]);
            savedLines++;
          } catch (lineErr) {
            console.warn('[mediaStream] transcript line not saved:', lineErr.message);
          }
        }
        if (this.transcript.length !== savedLines) {
          console.warn(`[mediaStream] ${this.callId}: saved ${savedLines}/${this.transcript.length} transcript lines`);
        }

        await update(
          'UPDATE calls SET duration = ?, status = ?, ended_at = NOW(), credits_used = ?, blood_group = COALESCE(?, blood_group), engine_used = COALESCE(?, engine_used) WHERE id = ?',
          [duration, status, cost, this.bloodGroup || null, this.engineUsed || null, this.callDbId]
        );

        // Debit credits if duration > 0
        if (cost > 0 && status === 'completed') {
          const blocks = Math.max(1, Math.ceil(duration / 30));
          const billableMins = blocks * 0.5;
          await debit(this.orgId, cost, `Live Call ${this.callId} (${duration}s · ${billableMins}m @ ₹${rate}/min [VoBiz Stream])`, this.callId).catch(() => {});
          realtime.emit(this.orgId, 'credits.updated', { balance: (await getWallet(this.orgId)).balance });
        }

        // Score the call. This was missing entirely, and it is why the employee
        // Overview showed zeros after a real call: finishCall() wrote duration,
        // status and credits but never outcome/summary/sentiment/intent, so a
        // completed, billed call left calls.outcome NULL. Every downstream number
        // is derived from that column - Outcome breakdown, Qualified, Hot leads,
        // conversion - so the whole dashboard read as if nothing had happened.
        const callRow = await queryOne('SELECT * FROM calls WHERE id = ?', [this.callDbId]);
        const analysis = await this.analyzeCompletedCall(callRow, duration, status);

        // Persist the mixed call recording. Without this the call has no audio at
        // all, because <Stream> gives us no carrier-side recording to point at.
        // A carrier-supplied URL (Twilio/VoBiz) always wins over our own capture.
        const recUrl = await this.persistRecording(duration);

        // Notify dashboard / UI in realtime that the call is completed
        realtime.emit(this.orgId, 'call.completed', {
          callId: this.callId,
          callDbId: this.callDbId,
          status,
          duration,
          outcome: analysis?.outcome || status,
          summary: analysis?.summary,
          creditsUsed: cost,
          recordingUrl: recUrl || callRow?.recording_url,
        });

        // Trigger post-call automations (WhatsApp follow-up & summary email)
        const { sendFollowUp } = require('./whatsappService');
        const { sendCallSummaryEmail } = require('./mail');

        if (callRow?.phone_number) {
          sendFollowUp({
            to: callRow.phone_number,
            employeeName: this.employee?.name || 'Charan',
            // Was hardcoded to 'interested' regardless of what was actually said,
            // so every lead got an "interested" follow-up. Use the real verdict,
            // and never send an interested follow-up for a call that was not.
            outcome: analysis?.outcome || status,
            summary:
              analysis?.summary ||
              `Call ended after ${duration}s with status "${status}". No summary was generated.`,
            nextAction: analysis?.nextAction || 'Review the call recording.',
          }).catch(() => {});
        }

        sendCallSummaryEmail({
          callId: this.callId,
          duration,
          transcript: this.transcript,
          employeeName: this.employee?.name || 'Charan',
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[mediaStream] Finish call error:', err.message);
    }

    try {
      this.hangUpAtCarrier(status);
    } catch (err) {
      console.warn(`[mediaStream] Carrier hangup failed for ${this.callId}: ${err.message}`);
    }

    try {
      this.ws.close();
    } catch {}
  }

  /**
   * End the call at the carrier.
   *
   * Two steps, both required. Closing the socket only tears down the media
   * path - the PSTN leg stays up and keeps accruing carrier charges until VoBiz
   * times it out, which is how a finished call kept billing. The documented
   * way to end the stream is an outbound {"event":"stop"} frame; the docs are
   * explicit that no inbound stop event is ever sent, so this must be sent by
   * us. The REST hangup then terminates the leg itself.
   */
  async hangUpAtCarrier(status = 'completed') {
    if (this.carrierHungUp) return;
    this.carrierHungUp = true;

    // 1. Stop the stream so VoBiz leaves the <Stream> element.
    if (this.streamSid && this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify({ event: 'stop', streamId: this.streamSid }));
      } catch (err) {
        console.warn(`[mediaStream] Could not send stream stop for ${this.callId}: ${err.message}`);
      }
    }

    // 2. Terminate the carrier leg. Only worth calling for a call that
    // actually connected; a call that never answered has nothing to tear down.
    if (status !== 'completed' && status !== 'connected') return;

    const uuid = this.carrierCallUuid || this.requestId || this.callId;
    if (!uuid) return;

    try {
      const { getTelephonyProvider } = require('../providers');
      await getTelephonyProvider('vobiz').hangupCall(uuid);
      console.log(`[mediaStream] Carrier hangup sent for ${this.callId} (uuid=${uuid})`);
    } catch (err) {
      // 404 here just means the carrier already ended it, which is the outcome
      // we wanted anyway.
      if (!/404|not found/i.test(err.message || '')) throw err;
    }
  }
}

function createSimpleWavHeader(dataBuffer, sampleRate = 8000, numChannels = 1, bitsPerSample = 8) {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataLength = dataBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(7, 20); // 7 = mu-law
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, dataBuffer]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// WebSocket Handler Integration
// -----------------------------------------------------------------------------
async function handleMediaStreamConnection(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname; // e.g. /ws/vobiz/call_123/3, /vobiz-stream, /ws/twilio/call_123/3

  const parts = pathname.split('/').filter(Boolean);
  let provider = 'vobiz';
  let callId = url.searchParams.get('callId') || url.searchParams.get('call_id');
  let employeeId = parseInt(url.searchParams.get('employeeId') || url.searchParams.get('employee_id') || '0', 10);

  if (parts[0] === 'ws') {
    provider = parts[1] === 'twilio' ? 'twilio' : 'vobiz';
    callId = callId || parts[2];
    employeeId = employeeId || parseInt(parts[3] || '0', 10);
  } else if (parts[0] === 'vobiz-stream') {
    provider = 'vobiz';
    callId = callId || parts[1];
    employeeId = employeeId || parseInt(parts[2] || '0', 10);
  } else {
    provider = parts[0] === 'twilio' ? 'twilio' : 'vobiz';
    callId = callId || parts[1];
    employeeId = employeeId || parseInt(parts[2] || '0', 10);
  }

  callId = callId || `stream_${Date.now()}`;
  try {
    callId = decodeURIComponent(callId);
  } catch {}

  // If employeeId is missing from URL, attempt resolution from calls table
  if (!employeeId && callId) {
    try {
      const { queryOne } = require('../config/db');
      const row = await queryOne(
        'SELECT employee_id FROM calls WHERE call_id = ? OR request_id = ? LIMIT 1',
        [callId, callId]
      );
      if (row?.employee_id) employeeId = row.employee_id;
    } catch {}
  }

  console.log(`[mediaStream] Inbound WebSocket connection on ${pathname} -> Provider: ${provider}, Call: ${callId}, Emp: ${employeeId}`);

  // No employee id is not recoverable
  if (!employeeId) {
    try {
      ws.send(JSON.stringify({ event: 'error', message: 'employeeId is required on the media stream URL or call record.' }));
      ws.close(1008, 'employeeId required');
    } catch { /* already gone */ }
    return;
  }

  const session = new MediaStreamSession({ ws, provider, callId, employeeId });
  session.init();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (provider === 'vobiz') {
        session.handleVoBizMessage(msg);
      } else {
        session.handleTwilioMessage(msg);
      }
    } catch (e) {
      console.warn('[mediaStream] Failed to parse message JSON:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[mediaStream] WebSocket closed for ${callId}`);
    session.finishCall('completed');
  });

  // The carrier tears the media socket down when the call ends; that reset is
  // routine. Only log real protocol faults, and never let one crash the process.
  ws.on('error', (err) => {
    if (err?.code === 'ECONNRESET' || /aborted|reset/i.test(err?.message || '')) {
      console.log(`[mediaStream] Socket reset for ${callId} (call ended at the carrier)`);
      return;
    }
    console.error(`[mediaStream] WebSocket error on ${callId}:`, err.message);
  });

  // A media socket that goes silent mid-call (carrier drops without a FIN) is
  // indistinguishable from an idle one. Ping it so the dead socket is reaped
  // with a close frame instead of lingering until the TCP stack resets it.
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  const mediaHeartbeat = setInterval(() => {
    if (ws.readyState !== 1 /* OPEN */) {
      clearInterval(mediaHeartbeat);
      return;
    }
    if (ws.isAlive === false) {
      clearInterval(mediaHeartbeat);
      try {
        ws.close(1001, 'media stream idle');
      } catch {
        /* ignore */
      }
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      clearInterval(mediaHeartbeat);
    }
  }, 20000);
  if (mediaHeartbeat.unref) mediaHeartbeat.unref();
  ws.on('close', () => clearInterval(mediaHeartbeat));
}

module.exports = {
  MediaStreamSession,
  handleMediaStreamConnection,
  echoTextScore,
  isSubstantiveUtterance,
};
