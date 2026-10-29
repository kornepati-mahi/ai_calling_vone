const express = require('express');
const { query, queryOne, insert, update } = require('../config/db');
const { asyncHandler, generateId, SQL_NOW, buildSetClause } = require('../utils/helpers');
const { AppError } = require('../utils/errors');
const config = require('../config/env');
const realtime = require('../services/realtime');
const { getTelephonyProvider, generateLiveKitToken } = require('../providers');
const { optionalAuth, requireOrg } = require('../middleware/auth');
const { calculateCallCost, getVoicePerMinuteRate, debit, getWallet } = require('../services/credits');

const router = express.Router();

// -----------------------------------------------------------------------------
// Recording URL helpers
// -----------------------------------------------------------------------------

// Twilio's RecordingUrl is an extension-less resource path ("…/Recordings/RE…")
// that the caller must complete with a container. VoBiz and CDN hosts already
// return a full URL with an extension. Appending ".mp3" unconditionally turned a
// valid VoBiz URL into "…/recording.mp3.mp3", which 404s — the browser then had a
// recording row pointing at nothing, i.e. no audio after the call completed.
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|ogg|opus|weba|webm|flac|aac|amr)(?:$|[?#])/i;

function normalizeRecordingUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:')) return trimmed;
  if (AUDIO_EXT_RE.test(trimmed)) return trimmed;
  return `${trimmed}.mp3`;
}

// Keep call_recordings in step with calls.recording_url. The dashboard falls
// back to call_recordings when there is no top-level URL, and it carries the
// duration, so a carrier recording saved only on `calls` was invisible there.
async function recordCallRecording(dbCallId, url, duration = 0) {
  if (!dbCallId || !url) return;
  try {
    const existing = await queryOne(
      'SELECT id FROM call_recordings WHERE call_id = ? AND url = ?',
      [dbCallId, url]
    );
    if (existing) {
      if (duration) {
        await update('UPDATE call_recordings SET duration = ? WHERE id = ?', [duration, existing.id]);
      }
      return;
    }
    await insert(
      'INSERT INTO call_recordings (call_id, url, duration, size_bytes) VALUES (?,?,?,?)',
      [dbCallId, url, duration || 0, 0]
    );
  } catch (err) {
    console.warn('[telephony] Could not write call_recordings row:', err.message);
  }
}


// -----------------------------------------------------------------------------
// Telephony Webhook / Status Callback (Twilio & VoBiz)
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// Callback Field Normalisation (Twilio & VoBiz)
//
// Carriers disagree on almost every field name. VoBiz documents its voice
// callbacks as application/x-www-form-urlencoded with PascalCase keys
// (CallUUID, RequestUUID, ALegUUID, Event, CallStatus, SessionStart,
// StartTime/AnswerTime/EndTime, STIRAttestation, HangupCause). Twilio posts
// CallSid/CallStatus/CallDuration. Accept every documented shape on both sides.
// -----------------------------------------------------------------------------

// VoBiz sends four distinct UUIDs; any of them identifies the call row we
// stored. CallUUID is the one carried by the WebSocket `start` event too, so it
// is the best join key, but RequestUUID is what makeCall returned, so both are
// accepted plus the two A-leg variants.
const CARRIER_ID_FIELDS = [
  'CallSid',            // Twilio
  'CallUUID',           // VoBiz
  'RequestUUID',        // VoBiz
  'ALegUUID',           // VoBiz
  'ALegRequestUUID',    // VoBiz
  'callId',
  'call_id',
  'providerCallId',
];

function pickCarrierCallId(body, queryParams) {
  for (const field of CARRIER_ID_FIELDS) {
    if (body[field]) return String(body[field]);
  }
  return queryParams.callId ? String(queryParams.callId) : '';
}

/**
 * Compute billable duration from the documented VoBiz timestamps.
 *
 * VoBiz does not put a duration on hangup_url; it gives StartTime, AnswerTime,
 * EndTime (local "yyyy-MM-dd HH:mm:ss") plus SessionStart (UTC, with
 * microseconds). AnswerTime is the only field that separates ring time from
 * talk time, so talk seconds = EndTime - AnswerTime. Parsed as local wall time
 * by matching on the components rather than trusting a JS Date parse of an
 * ambiguous format string.
 */
function parseCarrierTimestamp(value) {
  if (!value) return null;
  const m = String(value)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function computeTalkSeconds(body) {
  const answer = parseCarrierTimestamp(body.AnswerTime);
  const end = parseCarrierTimestamp(body.EndTime);
  if (answer && end) {
    const secs = Math.round((end.getTime() - answer.getTime()) / 1000);
    if (Number.isFinite(secs) && secs >= 0) return secs;
  }
  return null;
}

/**
 * Summarise the documented hangup fields into one readable string.
 *
 * VoBiz hangup_url carries HangupCause (NORMAL_CLEARING, USER_BUSY, ...),
 * HangupCauseCode, HangupSource (Caller / Callee / Vobiz / API Request /
 * Answer XML / Error) and the STIR attestation. Only some appear in any given
 * payload, so each part is included when present.
 */
function buildDisconnectReason(body) {
  const parts = [];
  if (body.HangupCause) parts.push(String(body.HangupCause));
  if (body.HangupCauseCode) parts.push(`code ${body.HangupCauseCode}`);
  if (body.HangupSource) parts.push(`source ${body.HangupSource}`);
  if (body.HangupDisposition) parts.push(String(body.HangupDisposition));
  if (body.STIRAttestation) parts.push(`STIR ${body.STIRAttestation}`);
  return parts.join(' · ') || null;
}

/**
 * Resolve the local call row from any of the carrier's UUIDs.
 *
 * VoBiz uses four different identifiers for one call - RequestUUID on the make
 * response, CallUUID on the answer and hangup callbacks, and ALegUUID /
 * ALegRequestUUID on the callbacks - so each candidate is tried in turn. The
 * old lookup only ever passed CallUUID and RequestUUID, which meant a hangup
 * callback carrying only ALegUUID never matched a call and the call stayed
 * "connected" forever.
 *
 * carrier_call_uuid is matched too: CallUUID is a different value from the
 * request_uuid we store in request_id, and a callback carrying only CallUUID
 * (which the docs show is possible) has nothing else to join on.
 */
async function findCallByCarrierId(identifiers) {
  const candidates = [...new Set(identifiers.filter(Boolean).map(String))];
  for (const id of candidates) {
    const row = await queryOne(
      `SELECT * FROM calls
       WHERE request_id = ? OR call_id = ? OR carrier_call_uuid = ?
       ORDER BY id DESC LIMIT 1`,
      [id, id, id]
    );
    if (row) return row;
  }
  return null;
}

/**
 * Remember the carrier's CallUUID on the call row.
 *
 * The WebSocket `start` event is documented to carry start.callId identical to
 * the CallUUID on the REST and callback payloads, so this is where that second
 * UUID first becomes known. Persisting it is what lets a later hangup callback
 * that carries only CallUUID find this call.
 */
async function rememberCarrierCallUuid(dbCallId, callUuid) {
  if (!dbCallId || !callUuid) return;
  await update(
    'UPDATE calls SET carrier_call_uuid = ? WHERE id = ? AND (carrier_call_uuid IS NULL OR carrier_call_uuid = ?)',
    [String(callUuid), dbCallId, String(callUuid)]
  ).catch(() => {});
}

/**
 * Close out a campaign lead once the carrier reports a terminal call status.
 *
 * A bulk dial writes one shared batch request_uuid onto every destination row,
 * so findCallByCarrierId can only ever resolve one of them. The carrier call
 * uuid is therefore used when the callback carries one, and the campaign lead is
 * only settled if it is still "calling" - the WHERE guard makes a duplicated
 * callback a no-op instead of double-counting completed_leads.
 */
async function settleCampaignLead(call, normalizedStatus) {
  const completed = normalizedStatus === 'completed';
  const leadStatus = completed ? 'completed' : 'failed';

  const res = await update(
    `UPDATE campaign_leads
        SET status = ?, called_at = COALESCE(called_at, NOW()), last_error = ?
      WHERE campaign_id = ? AND lead_id = ? AND status = "calling"`,
    [leadStatus, completed ? null : normalizedStatus, call.campaign_id, call.lead_id]
  );

  if (!res.changedRows) return;

  await update(
    `UPDATE campaigns
        SET ${completed ? 'completed_leads' : 'failed_leads'} = ${completed ? 'completed_leads' : 'failed_leads'} + 1
      WHERE id = ?`,
    [call.campaign_id]
  );
}

router.post('/webhook', express.urlencoded({ extended: true }), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const queryParams = req.query || {};

  // Verify the carrier's HMAC signature when one is present. The signature
  // headers only exist if auth credentials were configured on the callback URL
  // in the VoBiz console, so an unsigned callback is logged rather than
  // rejected. Set VOBIZ_REQUIRE_SIGNATURE=true to enforce.
  const telephonyProvider = getTelephonyProvider();
  if (typeof telephonyProvider.verifyWebhookSignature === 'function') {
    const sig = telephonyProvider.verifyWebhookSignature(req);
    const requireSignature =
      String(process.env.VOBIZ_REQUIRE_SIGNATURE || '').toLowerCase() === 'true';
    if (sig.present && !sig.verified) {
      console.warn(`[webhook] Rejected carrier callback: ${sig.reason}`);
      if (requireSignature) {
        return res.status(401).type('text/xml').send('<Response></Response>');
      }
    } else if (sig.verified) {
      console.log(`[webhook] Carrier callback signature verified (${sig.version}).`);
    }
  }

  // If a number's inbound Voice URL is pointed at /webhook (instead of /inbound),
  // the carrier fires a VoiceRequest with NO call status. Returning an empty
  // <Response> connects the call but plays silence. Detect it and serve the same
  // bidirectional stream the /inbound route does.
  const hasStatusField = Object.keys(body).some((k) => /callstatus|^status$/i.test(k));
  const looksLikeVoiceRequest = body.From && body.To && !hasStatusField;
  if (looksLikeVoiceRequest) {
    res.type('text/xml');
    res.send(await buildInboundXml(req));
    return;
  }

  // Normalize fields across Twilio and VoBiz
  const providerCallId = pickCarrierCallId(body, queryParams);
  const carrierIds = [...CARRIER_ID_FIELDS.map((f) => body[f]), providerCallId].filter(Boolean);
  // CallStatus is the authoritative lifecycle field. `Event` is a wider
  // vocabulary (Ring, StartApp, Hangup, RecordStop, MachineDetection, ...) and
  // is used as a fallback, plus to identify events CallStatus alone misses.
  const eventName = body.Event || body.event || '';
  const rawStatus = (body.CallStatus || body.status || eventName || 'unknown').toLowerCase();
  const duration =
    parseInt(body.CallDuration || body.Duration || body.duration || '0', 10) ||
    computeTalkSeconds(body) ||
    0;
  // Carriers disagree on the field name and casing: Twilio posts RecordingUrl,
  // VoBiz posts recording_url (and sometimes recordingUrl) depending on the
  // endpoint. Accept every shape, otherwise the recording silently never lands.
  const recordingUrl = normalizeRecordingUrl(
    body.RecordingUrl || body.recordingUrl || body.recording_url
  );
  const fromField = String(body.From || body.callerNumber || body.from || '').trim();
  const toField = String(body.To || body.to || '').trim();
  // On an OUTBOUND leg the customer is on `To` and `From` is our own Vobiz
  // number, so matching only `From` could never find the call. Try both, in
  // whichever order the direction suggests.
  const direction = String(body.Direction || body.direction || '').toLowerCase();
  const callerNumber = direction === 'outbound'
    ? (toField || fromField)
    : (fromField || toField);

  const statusMap = {
    initiated: 'ringing',
    ringing: 'ringing',
    'in-ring': 'ringing',
    dialing: 'ringing',
    'in-progress': 'connected',
    answered: 'connected',
    completed: 'completed',
    busy: 'busy',
    'no-answer': 'no_answer',
    noanswer: 'no_answer',
    failed: 'failed',
    canceled: 'failed',
  };
  // Answering machine detected. VoBiz posts this asynchronously when
  // machine_detection_url is set, with Machine (boolean) and IfMachine
  // ("continue" or "hangup"). A hangup verdict means nobody is on the line, so
  // the call is closed out and charged as an unanswered call.
  if (/^machinedetection$/i.test(eventName)) {
    const isMachine = body.Machine === true || String(body.Machine).toLowerCase() === 'true';
    const ifMachine = body.IfMachine === 'hangup' ? 'hangup' : 'continue';
    console.log(`[webhook] Machine detection result: machine=${isMachine}, action=${ifMachine}`);
    if (providerCallId) {
      const amdCall = await findCallByCarrierId(carrierIds);
      if (amdCall) {
        await insert('INSERT INTO call_events (call_id, event_type, payload) VALUES (?,?,?)', [
          amdCall.id,
          isMachine ? 'call.answering_machine' : 'call.human_detected',
          JSON.stringify({ machine: isMachine, ifMachine, callUuid: body.CallUUID || null }),
        ]);
        if (isMachine && ifMachine === 'hangup') {
          await update(
            `UPDATE calls SET status = 'no_answer', ended_at = NOW(), credits_used = 0,
             outcome = COALESCE(outcome, 'no_answer') WHERE id = ?`,
            [amdCall.id]
          );
          realtime.emit(amdCall.organization_id, 'call.no_answer', {
            callId: amdCall.call_id,
            callDbId: amdCall.id,
            reason: 'answering_machine',
          });
        }
      }
    }
    return res.type('text/xml').send('<Response></Response>');
  }
  // Handle recording-completed status from Twilio (RecordingUrl arrives separately).
  // This MUST NOT read `call`: it is declared with `let` further down, so touching
  // it here threw "Cannot access 'call' before initialization". asyncHandler turned
  // that into a 500, which aborted the whole webhook — the call was never marked
  // completed, credits were never debited, and (the symptom that sent us looking)
  // the recording URL was never saved, so no audio appeared after the call.
  if (rawStatus === 'recording-completed' || rawStatus === 'completed') {
    const recUrl = normalizeRecordingUrl(body.RecordingUrl || body.recordingUrl || body.recording_url);
    if (recUrl && providerCallId) {
      const recCall = await findCallByCarrierId(carrierIds);
      if (recCall) {
        await update('UPDATE calls SET recording_url = ? WHERE id = ?', [recUrl, recCall.id]);
        await recordCallRecording(recCall.id, recUrl, duration);
        console.log('[webhook] Recording URL saved for call:', recCall.call_id, recUrl);
      }
      if (rawStatus === 'recording-completed') {
        res.type('text/xml').send('<Response></Response>');
        return;
      }
    }
  }

  const normalizedStatus = statusMap[rawStatus] || rawStatus;

  let call = null;
  if (carrierIds.length) {
    call = await findCallByCarrierId(carrierIds);
  }
  if (!call && callerNumber) {
    call = await queryOne(
      'SELECT * FROM calls WHERE phone_number = ? AND status IN ("preparing","ringing","connected") ORDER BY id DESC LIMIT 1',
      [callerNumber]
    );
  }

  if (call) {
    const orgId = call.organization_id;
    // Persist the CallUUID the callback carried so future callbacks that only
    // include CallUUID can still find this row.
    if (body.CallUUID) await rememberCarrierCallUuid(call.id, body.CallUUID);
    const updates = { status: normalizedStatus };
    if (normalizedStatus === 'connected' && !call.answered_at) {
      updates.answered_at = SQL_NOW;
    }
    if (normalizedStatus === 'failed' || normalizedStatus === 'busy' || normalizedStatus === 'no_answer') {
      updates.ended_at = SQL_NOW;
      updates.duration = duration || call.duration || 0;
      // Nobody picks up? You pay ₹0. Ringing, busy and unanswered calls cost nothing at all.
      updates.credits_used = 0;
      if (recordingUrl) updates.recording_url = recordingUrl;
    }

    if (recordingUrl) {
      await recordCallRecording(call.id, recordingUrl, duration || call.duration || 0);
    }
    if (normalizedStatus === 'completed') {
      updates.ended_at = SQL_NOW;
      const finalDuration = duration || call.duration || 0;
      updates.duration = finalDuration;
      if (finalDuration > 0 && !call.answered_at) {
        updates.answered_at = SQL_NOW;
      }
      if (recordingUrl) updates.recording_url = recordingUrl;

      // Deduct credits if not already debited
      if (!call.credits_used || call.credits_used === 0) {
        const employee = call.employee_id ? await queryOne('SELECT * FROM ai_employees WHERE id = ?', [call.employee_id]) : {};
        const creditsUsed = calculateCallCost({ duration: finalDuration, status: 'completed', employee });
        updates.credits_used = creditsUsed;
        if (creditsUsed > 0) {
          const rate = getVoicePerMinuteRate(employee);
          const blocks = Math.max(1, Math.ceil(finalDuration / 30));
          const billableMinutes = blocks * 0.5;
          try {
            await debit(orgId, creditsUsed, `Call ${call.call_id} (${finalDuration}s · ${billableMinutes}m @ ₹${rate}/min [30s blocks])`, call.call_id);
            realtime.emit(orgId, 'credits.updated', { balance: (await getWallet(orgId)).balance });
          } catch (debitErr) {
            console.error('[telephony] Credit debit error:', debitErr.message);
          }
        }
      }
    }

    // STIR/SHAKEN attestation and the hangup cause come straight off the
    // documented VoBiz hangup payload. Recording them is what makes it possible
    // to tell an agent-initiated hangup from a carrier or callee one.
    if (body.STIRAttestation || body.stir_verification || body.STIRVerification) {
      updates.carrier_hangup_reason = buildDisconnectReason(body);
    }

    const { sets, params } = buildSetClause(updates);
    await update(`UPDATE calls SET ${sets.join(', ')} WHERE id = ?`, [...params, call.id]);

    await insert('INSERT INTO call_events (call_id, event_type, payload) VALUES (?,?,?)', [
      call.id,
      `call.${normalizedStatus}`,
      JSON.stringify({ rawStatus, providerCallId, duration }),
    ]);

    realtime.emit(orgId, `call.${normalizedStatus}`, {
      callId: call.call_id,
      callDbId: call.id,
      status: normalizedStatus,
      duration: updates.duration ?? duration,
      recordingUrl,
    });

    // The status event is derived from the carrier's raw value, so answering
    // arrives as `call.connected` (statusMap folds in-progress/answered onto
    // it). UIs listen for the semantic `call.answered` - which the inbound path
    // already emits - so publish it alongside rather than making every consumer
    // know the carrier's vocabulary.
    if (normalizedStatus === 'connected') {
      realtime.emit(orgId, 'call.answered', {
        callId: call.call_id,
        callDbId: call.id,
        status: 'connected',
      });
    }

    // Reconcile campaign progress. A campaign lead is left in "calling" when the
    // carrier accepts the request, so this callback is the only place that can
    // resolve it - without it every bulk lead stayed "Calling" forever and the
    // completed/failed counters never moved off zero.
    if (['completed', 'failed', 'busy', 'no_answer'].includes(normalizedStatus) && call.campaign_id) {
      try {
        await settleCampaignLead(call, normalizedStatus);
      } catch (err) {
        console.warn(`[telephony] Could not settle campaign lead for call ${call.call_id}: ${err.message}`);
      }
    }

    // ✅ Post-call AI analysis — runs after 'completed' for gather-based calls
    if (normalizedStatus === 'completed') {
      setImmediate(async () => {
        try {
          const { getAIProvider } = require('../providers');
          const ai = getAIProvider();
          const employee = call.employee_id
            ? await queryOne('SELECT * FROM ai_employees WHERE id = ?', [call.employee_id])
            : null;

          // Load real transcripts saved during the gather session
          const transcriptRows = await query(
            'SELECT speaker, text FROM call_transcripts WHERE call_id = ? ORDER BY ts ASC',
            [call.id]
          );

          if (transcriptRows.length >= 2) {
            const analysis = await ai.analyzeCall(transcriptRows, employee);

            await update(
              `UPDATE calls SET sentiment=?, intent=?, summary=?, outcome=?, outcome_confidence=?, outcome_reason=?, next_action=? WHERE id=?`,
              [
                analysis.sentiment || null,
                analysis.intent || null,
                analysis.summary || null,
                analysis.outcome || null,
                analysis.outcomeConfidence || null,
                analysis.outcomeReason || null,
                analysis.nextAction || null,
                call.id,
              ]
            );

            // Save outcome record
            await insert(
              'INSERT INTO call_outcomes (call_id, outcome, confidence, reason, next_action) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE outcome=VALUES(outcome), confidence=VALUES(confidence), reason=VALUES(reason), next_action=VALUES(next_action)',
              [call.id, analysis.outcome || 'unknown', analysis.outcomeConfidence || 0, analysis.outcomeReason || null, analysis.nextAction || null]
            );

            realtime.emit(orgId, 'call.analyzed', {
              callId: call.call_id,
              callDbId: call.id,
              sentiment: analysis.sentiment,
              intent: analysis.intent,
              outcome: analysis.outcome,
              summary: analysis.summary,
            });
            console.log(`[webhook] Post-call analysis done for ${call.call_id}: ${analysis.outcome} (${analysis.sentiment})`);
          } else {
            console.log(`[webhook] Skipping analysis for ${call.call_id}: only ${transcriptRows.length} transcript lines`);
          }
        } catch (analyzeErr) {
          console.warn('[webhook] Post-call analysis failed:', analyzeErr.message);
        }
      });
    }
  }

  // Twilio response
  res.type('text/xml');
  res.send('<Response></Response>');
}));

// -----------------------------------------------------------------------------
// Direct High-Speed Audio Serving for Twilio (Zero Upload Latency)
// -----------------------------------------------------------------------------
const { storeAudio, getAudio } = require('../services/audioCache');

// The extension is whatever the stored bytes actually are. Previously every URL
// ended in ".mp3" while the body was often a WAV (Sarvam returns WAV), and
// carriers mis-decode a mislabelled container - the caller heard nothing while
// the transcript kept working. The content type is likewise taken from what was
// stored, and the route matches any extension so old cached URLs keep working.
router.get('/audio/:audioId.:ext', (req, res) => {
  const item = getAudio(req.params.audioId);
  if (!item) {
    return res.status(404).send('Audio not found');
  }
  res.set({
    'Content-Type': item.contentType || 'audio/mpeg',
    'Content-Length': item.buffer.length,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(item.buffer);
});

// ".wav" is the reliable container for carriers fetching a <Play> URL; Twilio's
// own guidance is to avoid .mp3 there because of transcoding delay. Returns the
// extension matching the content type we just stored.
function audioExtFor(contentType) {
  return /wav|x-pn-wav|wave/i.test(String(contentType || '')) ? 'wav' : 'mp3';
}

// -----------------------------------------------------------------------------
// Active in-memory session manager for ongoing calls (multi-turn memory)
// -----------------------------------------------------------------------------
const callSessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, sess] of callSessions.entries()) {
    if (now - sess.lastActivity > 30 * 60 * 1000) {
      callSessions.delete(key);
    }
  }
}, 5 * 60 * 1000);

// -----------------------------------------------------------------------------
// VoBiz Bidirectional Media Stream XML (Primary Telephony Provider)
// -----------------------------------------------------------------------------
router.all(['/vobiz/stream', '/vobiz/stream/:callId/:employeeId'], express.urlencoded({ extended: true }), asyncHandler(async (req, res) => {
  const params = req.params || {};
  const queryParams = req.query || {};
  const body = req.body || {};

  const callId = params.callId || queryParams.callId || body.CallSid || body.callId || `vb_${Date.now()}`;
  const empId = parseInt(params.employeeId || queryParams.employeeId || '3', 10);

  const host = (req.headers['x-forwarded-host'] || req.headers.host || 'api.vobiz.ai').split(':')[0];
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const wsProto = proto === 'https' ? 'wss' : 'ws';

  let wsBase = host && !host.includes('localhost') && !host.includes('127.0.0.1')
    ? `${wsProto}://${host}`
    : (process.env.PUBLIC_WEBHOOK_URL ? process.env.PUBLIC_WEBHOOK_URL.replace(/^http/, 'ws') : `${wsProto}://${host}`);

  const wsUrl = `${wsBase}/ws/vobiz/${encodeURIComponent(callId)}/${empId}`;
  const httpBase = host && !host.includes('localhost') && !host.includes('127.0.0.1')
    ? `${proto}://${host}`
    : (process.env.PUBLIC_WEBHOOK_URL ? process.env.PUBLIC_WEBHOOK_URL.replace(/\/+$/, '') : `${proto}://${host}`);

  const recCallback = `${httpBase}/api/telephony/recording-callback`;
  const streamStatusCallback = `${httpBase}/api/telephony/stream-status`;

  console.log(`[vobiz:stream] Serving VoBiz Stream XML -> ${wsUrl} (recCallback=${recCallback})`);

  // keepCallAlive="true" makes <Stream> execute exclusively: the call stays in
  // this element until the socket disconnects, which is what gives real barge-in
  // instead of the AI talking over the customer.
  //
  // audioTrack must be "inbound" for a bidirectional stream - the docs note
  // "both" is only valid one-way, and the inbound track carries the caller.
  //
  // statusCallbackUrl delivers StartStream, PlayedStream, ClearedAudio,
  // DegradedStream, DroppedStream and StopStream. DegradedStream and
  // DroppedStream are the only documented signal that the media path died
  // mid-call, which is otherwise invisible from our side.
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" callbackUrl="${recCallback}" callbackMethod="POST" redirect="false" playBeep="false" fileFormat="mp3" />
  <Stream bidirectional="true" keepCallAlive="true" audioTrack="inbound" maxRetries="3" statusCallbackUrl="${streamStatusCallback}" statusCallbackMethod="POST" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream>
</Response>`);
}));

// -----------------------------------------------------------------------------
// Vobiz Audio Stream Status Callback
//
// Form-encoded POST from the carrier with Event, CallUUID, StreamID, From, To,
// Timestamp and, for failures, Error. Documented events:
//
//   StartStream        - socket established
//   PlayedStream       - playback reached a checkpoint (carries Name)
//   ClearedAudio       - our clearAudio was processed
//   DegradedStream     - Error: "connection degraded"
//   DroppedStream      - Error: "connection disconnected with the remote service"
//   StopStream         - server-initiated stop only; NOT sent on caller hangup
//
// A dropped or degraded stream means the caller went silent even though the
// call was still billed, so it is surfaced as a live-call event.
// -----------------------------------------------------------------------------
router.post('/stream-status', express.urlencoded({ extended: true }), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const event = body.Event || body.event || '';
  const callUuid = body.CallUUID || body.CallUuid || body.call_uuid || '';
  const streamId = body.StreamID || body.StreamId || body.stream_id || '';
  const errorText = body.Error || body.error || '';

  console.log(`[vobiz:stream-status] ${event}${errorText ? ` (${errorText})` : ''} call=${callUuid} stream=${streamId}`);

  if (callUuid) {
    const call = await findCallByCarrierId([callUuid, streamId]);
    if (call) {
      await insert('INSERT INTO call_events (call_id, event_type, payload) VALUES (?,?,?)', [
        call.id,
        `stream.${String(event).toLowerCase() || 'unknown'}`,
        JSON.stringify({ event, streamId, error: errorText || null, name: body.Name || null }),
      ]).catch(() => {});

      if (/^(DroppedStream|DegradedStream)$/.test(event)) {
        realtime.emit(call.organization_id, 'call.media_degraded', {
          callId: call.call_id,
          callDbId: call.id,
          event,
          error: errorText,
          streamId,
        });
      }
    }
  }

  res.type('text/xml');
  res.send('<Response></Response>');
}));

// -----------------------------------------------------------------------------
// VoBiz Bulk-Stream XML
//
// A bulk dial sends one request for up to 1000 destinations, so there is a
// single answer_url for the whole batch and the per-call context has to come
// from the callback itself. VoBiz echoes the destination on the `To` field, so
// that is what identifies which lead is speaking.
// -----------------------------------------------------------------------------
router.all('/vobiz/bulk-stream/:campaignId', express.urlencoded({ extended: true }), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const campaignId = parseInt(req.params.campaignId, 10) || 0;

  // For an outbound leg the destination is `To`; `From` is our own Vobiz
  // number. Matching on From, as the single-call path once did, finds nothing.
  const destination = String(body.To || body.to || '').trim();
  const from = String(body.From || body.from || '').trim();
  const callUuid = body.CallUUID || body.call_uuid || null;

  let callRow = null;
  if (callUuid) callRow = await findCallByCarrierId([callUuid]);
  if (!callRow && destination) {
    // Match on the destination among calls still waiting to be answered.
    const candidates = [destination, destination.replace(/^\+/, ''), `+${destination.replace(/^\+/, '')}`];
    callRow = await queryOne(
      `SELECT * FROM calls
       WHERE phone_number IN (?)
         AND status IN ('preparing','ringing','connected')
         ${campaignId ? 'AND campaign_id = ?' : ''}
       ORDER BY id DESC LIMIT 1`,
      campaignId ? [candidates, campaignId] : [candidates]
    );
    if (callRow) await rememberCarrierCallUuid(callRow.id, callUuid);
  }

  if (!callRow) {
    console.warn(`[vobiz:bulk-stream] No call row for campaign=${campaignId} to=${destination || from}`);
    // Return a valid but inert document: VoBiz requires XML on answer, and a
    // non-XML body makes it retry the whole batch.
    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>Sorry, please call again later.</Say></Response>');
    return;
  }

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0];
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const wsProto = proto === 'https' ? 'wss' : 'ws';
  const publicHost = host && !host.includes('localhost') && !host.includes('127.0.0.1')
    ? host
    : String(process.env.PUBLIC_WEBHOOK_URL || '').replace(/^https?:\/\//, '').split('/')[0].trim();
  if (!publicHost) {
    console.warn('[vobiz:bulk-stream] No public host available for the media socket.');
    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?>\n<Response><Say>Sorry, please call again later.</Say></Response>');
    return;
  }

  const wsUrl = `${wsProto}://${publicHost}/ws/vobiz/${encodeURIComponent(callRow.call_id)}/${callRow.employee_id || 3}`;
  const httpBase = `${proto}://${publicHost}`;
  const recCallback = `${httpBase}/api/telephony/recording-callback`;
  const streamStatusCallback = `${httpBase}/api/telephony/stream-status`;

  console.log(`[vobiz:bulk-stream] campaign=${campaignId} to=${destination} -> call ${callRow.call_id} ws=${wsUrl}`);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" callbackUrl="${recCallback}" callbackMethod="POST" redirect="false" playBeep="false" fileFormat="mp3" />
  <Stream bidirectional="true" keepCallAlive="true" audioTrack="inbound" maxRetries="3" statusCallbackUrl="${streamStatusCallback}" statusCallbackMethod="POST" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream>
</Response>`);
}));

// -----------------------------------------------------------------------------
// Twilio Media Stream TwiML (Test Calls / Secondary Fallback)
// -----------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Ultra-fast in-memory response cache: pre-synthesize greeting/silence phrases
// ---------------------------------------------------------------------------
const QUICK_REPLIES = new Map(); // text -> audioId (pre-warmed for instant playback)

// ---------------------------------------------------------------------------
// Twilio <Connect><Stream> — bidirectional media, the only way to get real
// barge-in.
// ---------------------------------------------------------------------------
// <Gather> cannot do this: Twilio only starts listening for the caller AFTER a
// nested <Play> finishes, so `bargeIn="true"` has no audio to interrupt and the
// AI talks straight over anyone who speaks. <Stream> keeps audio flowing in both
// directions, which lets us cut the AI off mid-word.
//
// Streaming requires a wss:// URL Twilio can reach. The active tunnel serves
// both, so this normally works with no extra setup; TLS_WS_URL overrides it with
// a stable domain. Without any usable origin it falls back to <Gather>, where
// the caller cannot barge in.
router.all('/twiml/stream/:callId/:employeeId', express.urlencoded({ extended: true }), asyncHandler(async (req, res) => {
  const { callId, employeeId } = req.params;
  const body = req.body || {};

  const { getPublicWsUrl } = require('../services/tunnelService');
  const wsBase = getPublicWsUrl();

  if (!wsBase) {
    console.warn('[stream] No public wss:// origin available; falling back to <Gather> (no barge-in).');
    return res.redirect(307, `/api/telephony/twiml/gather/${encodeURIComponent(callId)}/${employeeId}`);
  }

  // Persist the carrier's call id so the media session can find its call row and
  // resolve the tenant from it.
  if (body.CallSid) {
    await update('UPDATE calls SET request_id = ? WHERE call_id = ?', [body.CallSid, callId]).catch(() => {});
  }

  const streamUrl = `${wsBase}/ws/twilio/${encodeURIComponent(callId)}/${employeeId}`;
  console.log(`[stream] Answering with bidirectional media: ${streamUrl}`);

  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`);
}));

router.all(['/twiml/gather', '/twiml/gather/:callId/:employeeId'], express.urlencoded({ extended: true }), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const queryParams = req.query || {};
  const params = req.params || {};
  const speechResult = (body.SpeechResult || '').trim();
  const digits = (body.Digits || '').trim();
  const callSid = body.CallSid || params.callId || queryParams.callId;
  const empId = parseInt(params.employeeId || queryParams.employeeId || '3', 10);
  const callId = params.callId || queryParams.callId || callSid;
  const t0 = Date.now();

  console.log('[gather] Received Twilio input:', { speechResult: speechResult.slice(0, 60), digits, callSid, empId });

  // Session
  const sessionKey = callSid || callId;
  let session = callSessions.get(sessionKey);
  if (!session) {
    session = { messages: [], silenceCount: 0, lastActivity: Date.now(), dbCallId: null, tsCount: 0 };
    callSessions.set(sessionKey, session);
  }
  session.lastActivity = Date.now();

  // Look up the call DB row so we can save real transcripts
  if (!session.dbCallId) {
    const dbCall = await queryOne(
      'SELECT id, organization_id FROM calls WHERE request_id = ? OR call_id = ? ORDER BY id DESC LIMIT 1',
      [callSid, callSid]
    );
    if (dbCall) {
      session.dbCallId = dbCall.id;
      session.orgId = dbCall.organization_id;
    }
  }

  // Helper: save one transcript line to DB (fire-and-forget, non-blocking)
  const saveLine = (speaker, text) => {
    if (!session.dbCallId || !text) return;
    const ts = ++session.tsCount;
    insert('INSERT INTO call_transcripts (call_id, speaker, text, ts) VALUES (?,?,?,?)',
      [session.dbCallId, speaker, text, ts]
    ).catch(() => {});
    // Emit real-time transcript to dashboard
    if (session.orgId) {
      realtime.emit(session.orgId, 'call.transcript', { callDbId: session.dbCallId, speaker, text, ts });
    }
  };

  // Employee + provider
  const emp = await queryOne('SELECT * FROM ai_employees WHERE id = ?', [empId])
    || await queryOne('SELECT * FROM ai_employees WHERE id = 3');

  const { getAIProvider, resolveVoiceProvider } = require('../providers');
  const ai = getAIProvider();
  const voice = resolveVoiceProvider(emp?.voice, emp?.voice_provider);
  const chosenVoiceId = emp?.voice || '82c2afc8-ebbc-4802-8ccf-036dc0fa1e3b';

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').replace(/:\d+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  let publicBase = host && !host.includes('localhost') && !host.includes('127.0.0.1')
    ? `${proto}://${host}`
    : (process.env.PUBLIC_WEBHOOK_URL || `https://${host}`);

  // ----- Determine reply text ----
  const goodbyeTerms = ['bye', 'బాయ్', 'సరే థాంక్స్', 'కాల్ కట్', 'cut the call', 'తర్వాత మాట్లాడతాను', 'వద్దు', 'చాలు', 'థాంక్యూ చాలు'];
  const isGoodbye = goodbyeTerms.some((t) => speechResult.toLowerCase().includes(t));
  const isHello = ['hello', 'హలో', 'నమస్తే', 'నమస్కారం', 'hi', 'హాయ్'].some((h) => speechResult.toLowerCase().includes(h));

  let replyText = '';
  let shouldHangup = false;

  if (isGoodbye) {
    replyText = emp?.farewell_message || 'మాట్లాడినందుకు ధన్యవాదాలు అండి! వివరాలు వాట్సాప్ లో పంపిస్తున్నాము. హావ్ ఎ గ్రేట్ డే!';
    // Save user goodbye + AI farewell to transcript
    if (speechResult) saveLine('customer', speechResult);
    shouldHangup = true;
    callSessions.delete(sessionKey);
  } else if (speechResult) {
    session.silenceCount = 0;
    // ✅ Save real user speech to DB transcript
    saveLine('customer', speechResult);

    if (isHello && session.messages.length === 0 && speechResult.length < 30) {
      // Pre-canned instant hello reply — no LLM needed
      replyText = emp?.greeting?.replace('{name}', emp?.name || 'AI') ||
        'నమస్తే అండి! నేను మీకు ఎలా సహాయపడగలను?';
      session.messages.push({ role: 'user', content: speechResult });
      session.messages.push({ role: 'assistant', content: replyText });
    } else {
      session.messages.push({ role: 'user', content: speechResult });
      const recentTurns = session.messages.slice(-8);

      const basePrompt = emp?.system_prompt || `You are a friendly Telugu AI voice assistant. Help customers with their enquiries.`;

      const phonePrompt = `${basePrompt}

PHONE CALL RULES (MANDATORY):
- Respond in pure natural spoken Telugu only. NO English words unless the customer used them (like "2BHK", "website", "CRM").
- ALWAYS complete your sentence fully. NEVER end mid-word or mid-phrase.
- Keep reply to EXACTLY 1-2 short sentences. Maximum 25 Telugu words per reply.
- Sound like a warm, real human — not a robot. Use natural conversational flow.
- Ask only ONE question at a time. Wait for customer's answer before asking next.
- If customer says something unclear (like "ఇవి", "హెచ్"), gently ask them to repeat: "క్షమించండి అండి, కొంచెం స్పష్టంగా చెప్తారా?"
- Never list all options in one breath. If asking options, say: "2BHK కావాలా లేదా 3BHK కావాలా అండి?"
- Mirror the customer's energy — if they are brief, be brief. If they explain more, respond in detail.`;

      try {
        const aiRes = await ai.generateResponse(recentTurns, {
          systemPrompt: phonePrompt,
          temperature: 0.15,
          maxTokens: 120,   // Enough for 1-2 full Telugu sentences without cutoff
        });
        replyText = aiRes.text.replace(/[*_#\[\]]/g, '').trim();
        // Ensure sentence doesn't end abruptly mid-word
        if (replyText && !replyText.match(/[.!?।\u0964]$/)) replyText += '.';
        session.messages.push({ role: 'assistant', content: replyText });
      } catch (err) {
        console.warn('[gather] LLM error:', err.message);
        replyText = 'అర్థమైంది అండి! వెంటనే వాట్సాప్ లో పూర్తి వివరాలు పంపిస్తాము.';
        session.messages.push({ role: 'assistant', content: replyText });
      }
    }
  } else if (digits) {
    replyText = emp?.greeting?.replace('{name}', emp?.name || 'AI') ||
      'ధన్యవాదాలు అండి! మీకు ఏ సమాచారం కావాలో చెప్పండి.';
    session.silenceCount = 0;
  } else {
    // Silence handling
    if (session.messages.length === 0) {
      replyText = emp?.greeting?.replace('{name}', emp?.name || 'AI') ||
        'నమస్కారం అండి! మీకు ఏ సమాచారం కావాలో చెప్పండి.';
      session.messages.push({ role: 'assistant', content: replyText });
    } else {
      session.silenceCount++;
      if (session.silenceCount === 1) {
        replyText = 'నేను వింటున్నాను అండి, చెప్పండి.';
      } else {
        replyText = 'ధన్యవాదాలు! మా వాట్సాప్ నంబర్‌కి సంప్రదించండి.';
        shouldHangup = true;
        callSessions.delete(sessionKey);
      }
    }
  }

  // ✅ Save AI reply to DB transcript
  if (replyText) saveLine('ai', replyText);

  // ----- Synthesize TTS — check quick cache first -----
  let audioUrl = null;
  const cacheKey = `${chosenVoiceId}::${replyText}`;

  if (QUICK_REPLIES.has(cacheKey)) {
    // Cache hit — instant!
    audioUrl = `${publicBase}/api/telephony/audio/${QUICK_REPLIES.get(cacheKey)}.mp3`;
    console.log(`[gather] Cache HIT for voice, total latency: ${Date.now() - t0}ms`);
  } else {
    try {
      const syn = await voice.synthesize(replyText, {
        voice: chosenVoiceId,
        language: emp?.language_code || 'te',
        speed: emp?.voice_speed || 0.82,   // Slower, more natural conversational pace
      });

      let buf = null;
      let ct = 'audio/mpeg';
      if (syn?.buffer) {
        buf = syn.buffer;
        ct = syn.contentType || 'audio/mpeg';
      } else if (syn?.audioUrl) {
        buf = Buffer.from(syn.audioUrl.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
        ct = 'audio/wav';
      }

      if (buf) {
        const audioId = storeAudio(buf, ct);
        audioUrl = `${publicBase}/api/telephony/audio/${audioId}.${audioExtFor(ct)}`;
        // Cache common short phrases
        if (replyText.length < 80) QUICK_REPLIES.set(cacheKey, audioId);
      }

      console.log(`[gather] TTS done in ${Date.now() - t0}ms, audioUrl ready`);
    } catch (err) {
      console.warn('[gather] Primary voice error:', err.message, '— Sarvam fallback...');
      try {
        const { SarvamProvider } = require('../providers/voice/sarvam');
        const sarvam = new SarvamProvider();
        const syn = await sarvam.synthesize(replyText, {
          voice: 'arvind',
          language: emp?.language_code || 'te-IN',
          speed: emp?.voice_speed || 1.0,
        });
        const buf = Buffer.from(syn.audioUrl.replace(/^data:audio\/\w+;base64,/, ''), 'base64');
        const audioId = storeAudio(buf, 'audio/wav');
        audioUrl = `${publicBase}/api/telephony/audio/${audioId}.wav`;
      } catch (sarvamErr) {
        console.warn('[gather] Sarvam fallback failed:', sarvamErr.message);
      }
    }
  }

  const nextGatherUrl = `${publicBase}/api/telephony/twiml/gather/${encodeURIComponent(callId)}/${emp?.id || 3}`;

  // Speech hints: Telugu words + English property/tech terms Twilio STT must recognize
  const speechHints = [
    // Greetings
    'hello, hi, నమస్తే, నమస్కారం, హలో, హాయ్',
    // Property terms (English + Telugu)
    '2BHK, 3BHK, 4BHK, 1BHK, two BHK, three BHK, flat, apartment, villa, plot, duplex, commercial',
    'అపార్ట్‌మెంట్, విల్లా, ప్లాట్, ఫ్లాట్, ప్రాపర్టీ, స్థలం',
    // Business/Tech terms
    'website, web development, CRM, WhatsApp CRM, e-commerce, React, budget, pricing',
    'వెబ్‌సైట్, వెబ్ డెవలప్‌మెంట్, బడ్జెట్, ధర, ధరలు, కొటేషన్, డెమో',
    // Responses
    'అవును, సరే, బాగుంది, అర్థమైంది, ధన్యవాదాలు, కాదు, వద్దు, సరిపోతుంది, చెప్పండి',
    'yes, no, okay, fine, good, correct, right, done, understood',
    // Numbers
    'పదిహేను వేలు, ఇరవై వేలు, ముప్పై వేలు, లక్ష, రెండు లక్షలు, కోటి',
    // Goodbye
    'bye, బాయ్, థాంక్యూ, ధన్యవాదాలు, చాలు, సరే థాంక్యూ'
  ].join(', ');

  res.type('text/xml');
  console.log(`[gather] Responding in ${Date.now() - t0}ms total`);

  // Status callback URL so Twilio posts recording URL when call ends
  const statusCallbackUrl = `${publicBase}/api/telephony/webhook`;

  if (shouldHangup) {
    // On hangup — request Twilio to record this call and send us the URL
    const hangupTwiml = audioUrl
      ? `<Response><Play>${audioUrl}</Play><Record action="${statusCallbackUrl}" maxLength="3600" recordingStatusCallback="${statusCallbackUrl}" recordingStatusCallbackMethod="POST" trim="trim-silence"/></Response>`
      : `<Response><Say language="te-IN">${replyText}</Say><Record action="${statusCallbackUrl}" maxLength="3600" recordingStatusCallback="${statusCallbackUrl}" recordingStatusCallbackMethod="POST" trim="trim-silence"/></Response>`;
    return res.send(hangupTwiml);
  }

  // BargeIn=true: user CAN interrupt AI mid-speech
  // speechTimeout=auto: end-of-speech detection is automatic
  if (audioUrl) {
    res.send(`<Response>
  <Gather input="speech dtmf" bargeIn="true" timeout="8" speechTimeout="auto" language="te-IN" hints="${speechHints}" enhanced="true" speechModel="experimental_conversations" profanityFilter="false" partialResultStability="low" action="${nextGatherUrl}" method="POST">
    <Play>${audioUrl}</Play>
  </Gather>
  <Redirect method="POST">${nextGatherUrl}</Redirect>
</Response>`);
  } else {
    res.send(`<Response>
  <Gather input="speech dtmf" bargeIn="true" timeout="8" speechTimeout="auto" language="te-IN" hints="${speechHints}" enhanced="true" speechModel="experimental_conversations" profanityFilter="false" partialResultStability="low" action="${nextGatherUrl}" method="POST">
    <Say language="te-IN">${replyText}</Say>
  </Gather>
  <Redirect method="POST">${nextGatherUrl}</Redirect>
</Response>`);
  }
}));

// -----------------------------------------------------------------------------
// Inbound answer-URL builder.
//
// The outbound path already hands the carrier a bidirectional <Stream> pointing
// at our /ws/vobiz socket, which is the documented mechanism for a full-duplex
// AI voice agent. Inbound has to use the same one. It previously emitted
// Twilio-flavoured XML instead - <Gather input="speech dtmf">, <Say>, <Pause>,
// voice="Polly.Chitra", language="te-IN" - none of which exist in the Vobiz XML
// dialect, so an inbound call could never actually be answered by the AI.
// -----------------------------------------------------------------------------
async function buildInboundXml(req) {
  const body = req.body || {};
  const caller = body.From || body.callerNumber || 'Unknown Caller';
  const dialedNumber = body.To || body.agentNumber || body.dialedNumber || '';

  const phoneRow = await queryOne(
    `SELECT p.*, e.id AS employee_id, e.name AS employee_name, e.greeting, e.language_code
     FROM phone_numbers p
     LEFT JOIN ai_employees e ON e.id = p.employee_id
     WHERE p.number = ? OR p.number = ?`,
    [dialedNumber, dialedNumber.replace(/^\+91/, '')]
  );

  // Falling back to organization 1 handed another tenant's caller to a different
  // tenant's employee. An unrecognised dialled number gets no AI at all.
  if (!phoneRow) {
    console.warn(`[inbound] No phone_numbers row for dialled number "${dialedNumber}"; answering without an AI employee.`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup reason="rejected" />\n</Response>`;
  }

  const orgId = phoneRow.organization_id;
  const callId = body.callId || body.CallSid || body.CallUUID || generateId('call');
  const requestId = body.CallSid || generateId('inb');

  // The stream needs an employee to be the AI on the line. Prefer the one
  // assigned to the number, otherwise the org's first active employee.
  let employeeId = phoneRow.employee_id || null;
  if (!employeeId) {
    const fallback = await queryOne(
      `SELECT id FROM ai_employees WHERE organization_id = ? AND status = "active" ORDER BY id ASC LIMIT 1`,
      [orgId]
    );
    employeeId = fallback?.id || null;
  }

  // calls.call_id is UNIQUE and carriers retry webhooks aggressively, so the
  // same inbound call arrives several times. Reuse the existing row instead of
  // failing the retry with "Duplicate entry ... for key 'uq_call_id'".
  const inboundCallUuid = body.CallUUID || body.call_uuid || null;
  const r = await insert(
    `INSERT INTO calls (call_id, organization_id, employee_id, phone_number, direction, status, request_id, carrier_call_uuid, started_at, answered_at)
     VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [callId, orgId, employeeId, caller, 'inbound', 'connected', requestId, inboundCallUuid]
  );
  // On a duplicate-key hit LAST_INSERT_ID(id) returns the existing row, so the
  // CallUUID is refreshed here rather than in the INSERT.
  await rememberCarrierCallUuid(r.insertId, inboundCallUuid);

  realtime.emit(orgId, 'call.created', {
    callId,
    callDbId: r.insertId,
    direction: 'inbound',
    phoneNumber: caller,
    employeeName: phoneRow.employee_name || 'AI Assistant',
  });
  realtime.emit(orgId, 'call.answered', { callId, callDbId: r.insertId });

  if (!employeeId) {
    console.warn(`[inbound] Org ${orgId} has no active employee for ${dialedNumber}; playing greeting and hanging up.`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup reason="rejected" />\n</Response>`;
  }

  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').replace(/:\d+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const publicBase = host && !host.includes('localhost') && !host.includes('127.0.0.1')
    ? `${proto}://${host}`
    : (process.env.PUBLIC_WEBHOOK_URL || `https://${host}`).replace(/\/+$/, '');

  const wsUrl = `${publicBase.replace(/^http/, 'ws')}/ws/vobiz/${encodeURIComponent(callId)}/${employeeId}`;
  const recCallback = `${publicBase}/api/telephony/recording-callback`;
  const streamStatusCallback = `${publicBase}/api/telephony/stream-status`;

  console.log(`[inbound] Answering with bidirectional Stream -> ${wsUrl}`);

  // Identical shape to the outbound stream: keepCallAlive makes <Stream>
  // exclusive so the call stays in it until we stop, which is what gives real
  // barge-in, and audioTrack="inbound" carries the caller.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Record recordSession="true" callbackUrl="${recCallback}" callbackMethod="POST" redirect="false" playBeep="false" fileFormat="mp3" />
  <Stream bidirectional="true" keepCallAlive="true" audioTrack="inbound" maxRetries="3" statusCallbackUrl="${streamStatusCallback}" statusCallbackMethod="POST" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream>
</Response>`;
}

// -----------------------------------------------------------------------------
// Inbound Call Handler (When a rented number is called)
// -----------------------------------------------------------------------------
router.post('/inbound', express.urlencoded({ extended: true }), asyncHandler(async (req, res) => {
  res.type('text/xml');
  res.send(await buildInboundXml(req));
}));

// -----------------------------------------------------------------------------
// LiveKit WebRTC Token Generator for Browser Audio Streaming
// -----------------------------------------------------------------------------
router.get('/livekit-token', optionalAuth, asyncHandler(async (req, res) => {
  const { room, identity, name } = req.query;
  const token = await generateLiveKitToken({
    room: room || 'ai-calling-demo',
    identity: identity || (req.user ? `user-${req.user.id}` : `guest-${Date.now()}`),
    name: name || (req.user ? req.user.name : 'Browser Guest'),
  });

  if (!token) {
    throw new AppError('LiveKit credentials not configured in .env (LIVEKIT_API_KEY, LIVEKIT_API_SECRET)', 500, 'LIVEKIT_NOT_CONFIGURED');
  }

  res.json({
    success: true,
    token,
    url: config.providers.livekit.url,
    room: room || 'ai-calling-demo',
  });
}));

// -----------------------------------------------------------------------------
// List Available Carrier Numbers
// -----------------------------------------------------------------------------
router.get('/carrier-numbers', requireOrg, asyncHandler(async (req, res) => {
  const telephony = getTelephonyProvider();
  const numbers = await telephony.listPhoneNumbers().catch(() => []);
  res.json({ success: true, numbers });
}));

// -----------------------------------------------------------------------------
// Recording Status Callback (VoBiz & Twilio call this when recording is ready)
//
// Vobiz requires an HTTP 200 within 3 SECONDS and retries a failed callback up
// to three times, so the response is sent before any slow work begins and the
// download runs detached. The carrier id is resolved through
// findCallByCarrierId, which also matches carrier_call_uuid: CallUUID is a
// different value from the request_uuid stored in request_id, so a callback
// carrying only CallUUID previously matched nothing and the audio was lost.
router.post('/recording-callback', express.urlencoded({ extended: true }), express.json(), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const identifiers = [
    body.CallSid, body.CallUUID, body.call_uuid, body.callId, body.RequestUUID, body.ALegUUID,
  ].filter(Boolean);
  const recordingSid = body.RecordingSid || body.RecordingID || body.recording_id || '';
  const recordingUrl = body.RecordFile || body.RecordUrl || body.RecordingUrl || body.recording_url || '';
  const recordingStatus = body.RecordingStatus || body.Event || '';
  const duration = body.RecordingDuration || body.Duration || 0;

  console.log('[recording] Callback received:', { identifiers, recordingSid, recordingUrl, recordingStatus, duration });

  // Acknowledge first: the 3-second budget must not be spent on any download.
  res.type('text/xml');
  res.send('<Response></Response>');

  if (!recordingUrl) return;

  const call = await findCallByCarrierId(identifiers);
  if (!call) {
    console.warn('[recording] No call found matching any identifier:', identifiers.join(', '));
    return;
  }

  const carrierUrl = normalizeRecordingUrl(recordingUrl);
  const durSec = parseInt(duration, 10) || 0;

  // Persist the carrier URL immediately — this is the authoritative reference
  // even if further processing below fails.
  await update('UPDATE calls SET recording_url = ? WHERE id = ?', [carrierUrl, call.id]);
  await recordCallRecording(call.id, carrierUrl, durSec);

  console.log(`[recording] Saved recording URL for call ${call.id}: ${carrierUrl}`);

  const realtime = require('../services/realtime');
  realtime.emit(call.organization_id, 'call.recording', {
    callId: call.call_id, callDbId: call.id, recordingUrl: carrierUrl, duration: durSec,
  });

  // Background mirror to InsForge persistent storage so audio never expires and is publicly playable
  (async () => {
    try {
      if (/vobiz\.ai/i.test(carrierUrl) && process.env.VOBIZ_AUTH_ID && process.env.VOBIZ_AUTH_TOKEN) {
        const parsed = new URL(carrierUrl);
        const https = require('https');
        const opts = {
          hostname: parsed.hostname,
          port: parsed.port || 443,
          path: parsed.pathname + parsed.search,
          headers: {
            'X-Auth-ID': process.env.VOBIZ_AUTH_ID,
            'X-Auth-Token': process.env.VOBIZ_AUTH_TOKEN,
          },
        };
        const chunks = [];
        await new Promise((resolve, reject) => {
          https.get(opts, (res) => {
            if (res.statusCode >= 400) return reject(new Error(`VoBiz download failed: ${res.statusCode}`));
            res.on('data', (c) => chunks.push(c));
            res.on('end', resolve);
            res.on('error', reject);
          }).on('error', reject);
        });
        const buf = Buffer.concat(chunks);
        if (buf.length > 0) {
          const { getInsforge } = require('../config/insforge');
          const insforge = await getInsforge();
          if (insforge) {
            const fileName = `${call.call_id}_vobiz.mp3`;
            const blob = new Blob([buf], { type: 'audio/mpeg' });
            const uploadRes = await insforge.storage.from('recordings').upload(fileName, blob);
            if (uploadRes?.data?.url) {
              await update('UPDATE calls SET recording_url = ? WHERE id = ?', [uploadRes.data.url, call.id]);
              await recordCallRecording(call.id, uploadRes.data.url, durSec);
              console.log(`[recording] Mirrored VoBiz audio to InsForge storage for call ${call.id}: ${uploadRes.data.url}`);
            }
          }
        }
      }
    } catch (mirrorErr) {
      console.warn('[recording] Background InsForge mirror failed (carrier URL remains active):', mirrorErr.message);
    }
  })();
}));

module.exports = router;
