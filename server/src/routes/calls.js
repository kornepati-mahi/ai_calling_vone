const express = require('express');
const { query, queryOne, insert, update } = require('../config/db');
const { asyncHandler, safeJson } = require('../utils/helpers');
const { AppError } = require('../utils/errors');
const { requireOrg } = require('../middleware/auth');
const { startInstantCall } = require('../services/callService');
const realtime = require('../services/realtime');
const { audit } = require('../services/activity');

const router = express.Router();
router.use(requireOrg);

router.post('/instant', asyncHandler(async (req, res) => {
  const { employee_id, purpose, from, name, customer_name, lead_name } = req.body;
  const rawPhone = req.body.phone || req.body.phone_number;
  if (!employee_id) throw new AppError('Select an AI employee', 400, 'VALIDATION');
  if (!rawPhone) throw new AppError('Phone number required', 400, 'VALIDATION');
  const leadName = (name || customer_name || lead_name || '').trim();
  const callPurpose = (purpose || '').trim();
  const result = await startInstantCall({
    org: req.organization,
    user: req.user,
    employeeId: parseInt(employee_id, 10),
    phoneNumber: String(rawPhone).trim(),
    name: leadName,
    purpose: callPurpose,
    from,
    isTest: !!req.body.is_test,
  });
  await audit(req, 'call.instant', 'call', result.callId, { phone: rawPhone, employee_id, leadName, callPurpose });
  res.json({ success: true, call: result });
}));

router.get('/', asyncHandler(async (req, res) => {
  const outpero = require('../services/outperoService');
  if (outpero.isConfigured()) {
    const calls = await outpero.listCalls();
    return res.json({ success: true, calls: calls.map((c) => ({
      id: c.id,
      call_id: c.id,
      organization_id: req.user.organization_id,
      employee_id: c.employee_id,
      phone_number: c.phone || c.to_number || '',
      direction: c.direction || 'outbound',
      status: c.status || 'completed',
      duration: c.duration_seconds || c.duration || 0,
      started_at: c.created_at || c.started_at,
      created_at: c.created_at,
      employee_name: c.employee_name || null,
      outcome: c.outcome || null,
      summary: c.summary || null,
    })), total: calls.length });
  }
  const orgId = req.user.organization_id;
  const { status, direction, employee_id, campaign_id, q, limit = 50, offset = 0 } = req.query;
  const where = ['calls.organization_id = ?'];
  const params = [orgId];
  if (status === 'active') { where.push('calls.status IN ("preparing","ringing","connected")'); }
  else if (status) { where.push('calls.status = ?'); params.push(status); }
  if (direction) { where.push('calls.direction = ?'); params.push(direction); }
  if (employee_id) { where.push('calls.employee_id = ?'); params.push(parseInt(employee_id, 10)); }
  if (campaign_id) { where.push('calls.campaign_id = ?'); params.push(parseInt(campaign_id, 10)); }
  if (q) { where.push('(calls.phone_number LIKE ? OR l.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const whereSql = where.join(' AND ');
  const rows = await query(
    `SELECT calls.*, e.name AS employee_name, l.name AS lead_name, l.company AS lead_company,
            camp.name AS campaign_name
     FROM calls
     LEFT JOIN ai_employees e ON e.id = calls.employee_id
     LEFT JOIN leads l ON l.id = calls.lead_id
     LEFT JOIN campaigns camp ON camp.id = calls.campaign_id
     WHERE ${whereSql}
     ORDER BY calls.created_at DESC
     LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}`,
    params
  );
  const totalRows = await query(`SELECT COUNT(*) AS c FROM calls WHERE ${whereSql}`, params);
  res.json({ success: true, calls: rows, total: totalRows[0].c });
}));

router.get('/live', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT calls.*, e.name AS employee_name, l.name AS lead_name
     FROM calls LEFT JOIN ai_employees e ON e.id = calls.employee_id
     LEFT JOIN leads l ON l.id = calls.lead_id
     WHERE calls.organization_id = ? AND calls.status IN ('preparing','ringing','connected')
     ORDER BY calls.created_at DESC`,
    [req.user.organization_id]
  );
  res.json({ success: true, calls: rows });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const call = await queryOne(
    `SELECT calls.*, e.name AS employee_name, e.role AS employee_role, e.avatar_url,
            l.name AS lead_name, l.phone AS lead_phone, l.company AS lead_company,
            camp.name AS campaign_name
     FROM calls
     LEFT JOIN ai_employees e ON e.id = calls.employee_id
     LEFT JOIN leads l ON l.id = calls.lead_id
     LEFT JOIN campaigns camp ON camp.id = calls.campaign_id
     WHERE calls.call_id = ? AND calls.organization_id = ?`,
    [req.params.id, req.user.organization_id]
  );
  if (!call) throw new AppError('Call not found', 404, 'NOT_FOUND');
  const [transcript, events, recordings, outcome] = await Promise.all([
    query('SELECT * FROM call_transcripts WHERE call_id = ? ORDER BY ts ASC', [call.id]),
    query('SELECT * FROM call_events WHERE call_id = ? ORDER BY id ASC', [call.id]),
    query('SELECT * FROM call_recordings WHERE call_id = ?', [call.id]),
    query('SELECT * FROM call_outcomes WHERE call_id = ?', [call.id]),
  ]);
  const recUrl = call.recording_url || recordings?.[0]?.url || null;
  const recordingProxyUrl = recUrl
    ? (/^https?:\/\//i.test(recUrl) && !/vobiz\.ai|twilio\.com/i.test(recUrl)
        ? recUrl
        : `/api/conversations/${call.call_id}/recording`)
    : null;
  res.json({
    success: true,
    call: {
      ...call,
      recording_url: recUrl,
      recording_proxy_url: recordingProxyUrl,
      transcript,
      events,
      recordings,
      analysis: outcome[0] || null
    }
  });
}));

router.get('/:id/transcript', asyncHandler(async (req, res) => {
  const call = await queryOne('SELECT * FROM calls WHERE call_id = ? AND organization_id = ?', [req.params.id, req.user.organization_id]);
  if (!call) throw new AppError('Call not found', 404, 'NOT_FOUND');
  const transcript = await query('SELECT * FROM call_transcripts WHERE call_id = ? ORDER BY ts ASC', [call.id]);
  res.json({ success: true, call_id: call.call_id, transcript });
}));

router.post('/:id/hangup', asyncHandler(async (req, res) => {
  const call = await queryOne('SELECT * FROM calls WHERE call_id = ? AND organization_id = ?', [req.params.id, req.user.organization_id]);
  if (!call) throw new AppError('Call not found', 404, 'NOT_FOUND');

  // Actually terminate the PSTN leg. The documented hangup is
  // DELETE /Account/{auth_id}/Call/{call_uuid}/ -> 204, which VoBizProvider
  // implements. Without this call the carrier kept streaming a billed call
  // while the database said "completed" - the exact opposite of what an
  // operator pressing hangup is asking for.
  let carrierHangup = null;
  if (call.request_id) {
    try {
      const { getTelephonyProvider } = require('../providers');
      carrierHangup = await getTelephonyProvider().hangupCall(call.request_id);
    } catch (err) {
      // A call that has already ended cannot be hung up; the local state is
      // still worth correcting, so report the reason but continue.
      carrierHangup = { status: 'error', error: err.message };
    }
  }

  // Bill for the talk time actually accumulated before the operator intervened.
  const { calculateCallCost, getVoicePerMinuteRate, debit } = require('../services/credits');
  const duration = Math.max(0, call.duration || 0);
  const employee = call.employee_id ? await queryOne('SELECT * FROM ai_employees WHERE id = ?', [call.employee_id]) : null;
  let creditsUsed = Number(call.credits_used || 0);
  if (!creditsUsed && duration > 0) {
    creditsUsed = calculateCallCost({ duration, status: 'completed', employee });
    if (creditsUsed > 0) {
      const rate = getVoicePerMinuteRate(employee);
      const billableMinutes = Math.max(1, Math.ceil(duration / 30)) * 0.5;
      await debit(
        req.user.organization_id,
        creditsUsed,
        `Call ${call.call_id} (${duration}s · ${billableMinutes}m @ ₹${rate}/min [manual hangup])`,
        call.call_id
      ).catch(() => {});
    }
  }

  await update(
    'UPDATE calls SET status = "completed", ended_at = NOW(), credits_used = ? WHERE id = ?',
    [creditsUsed, call.id]
  );
  await insert(
    'INSERT INTO call_events (call_id, event_type, payload) VALUES (?,?,?)',
    [call.id, 'call.manual_hangup', JSON.stringify({ by: req.user?.id || null, carrierHangup })]
  ).catch(() => {});

  realtime.emit(req.user.organization_id, 'call.completed', {
    callId: call.call_id,
    callDbId: call.id,
    status: 'completed',
    duration,
    creditsUsed,
    manuallyEnded: true,
  });
  res.json({ success: true, carrierHangup, duration, creditsUsed });
}));

module.exports = router;