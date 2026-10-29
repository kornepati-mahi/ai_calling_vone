const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');

// Agent that skips SSL cert verification — needed for some Twilio recording URLs
// that go through intermediate CAs not trusted by the local Node.js cert store.
const insecureAgent = new https.Agent({ rejectUnauthorized: false });
const { query, queryOne, update } = require('../config/db');
const { asyncHandler } = require('../utils/helpers');
const { AppError } = require('../utils/errors');
const { requireOrg } = require('../middleware/auth');
const { recordingFilePath } = require('../services/callRecording');
const { audit } = require('../services/activity');

const router = express.Router();

// Every route in this file — including the recording proxy — requires an
// authenticated org member. The proxy streams tenant audio, so it must never
// be reachable anonymously or with a guessed call_id.
router.use(requireOrg);

// -----------------------------------------------------------------------------
// Recording Proxy — requires auth and is scoped to the caller's organization.
// Handles both data:audio/... base64 URIs and https:// Twilio/CDN URLs.
// -----------------------------------------------------------------------------
router.get('/:id/recording', asyncHandler(async (req, res) => {
  const call = await queryOne(
    'SELECT recording_url FROM calls WHERE (call_id = ? OR id = ?) AND organization_id = ?',
    [req.params.id, req.params.id, req.user.organization_id]
  );
  if (!call || !call.recording_url) {
    return res.status(404).json({ error: 'No recording found' });
  }

  const recordingUrl = call.recording_url;

  // ── Case 1: data URI (e.g. data:audio/wav;base64,...) ──────────────────────
  if (recordingUrl.startsWith('data:')) {
    const match = recordingUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) {
      return res.status(400).json({ error: 'Malformed data URI' });
    }
    const mimeType = match[1];
    const buffer   = Buffer.from(match[2].trim(), 'base64');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.end(buffer);
  }

  // ── Case 2: locally captured recording (/api/recordings/<file>) ─────────
  if (/^\/api\/recordings\//.test(recordingUrl)) {
    const fileName = recordingUrl.split('/').pop();
    const full = recordingFilePath(fileName);
    if (!full || !fs.existsSync(full)) {
      return res.status(404).json({ error: 'Recording file missing on disk' });
    }
    const isMp3 = /\.mp3$/i.test(full);
    res.setHeader('Content-Type', isMp3 ? 'audio/mpeg' : 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return fs.createReadStream(full).pipe(res);
  }

  // ── Case 3: absolute http/https URL (VoBiz, Twilio, or CDN) ─────────────────────
  let parsedUrl;
  try {
    parsedUrl = new URL(recordingUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid recording URL' });
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return res.status(400).json({ error: 'Unsupported recording URL protocol' });
  }

  // Carrier authentication headers
  const authHeaders = {};
  if (/vobiz\.ai/i.test(parsedUrl.hostname)) {
    if (process.env.VOBIZ_AUTH_ID) authHeaders['X-Auth-ID'] = process.env.VOBIZ_AUTH_ID;
    if (process.env.VOBIZ_AUTH_TOKEN) authHeaders['X-Auth-Token'] = process.env.VOBIZ_AUTH_TOKEN;
  } else if (/twilio\.com/i.test(parsedUrl.hostname)) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
    const authToken  = process.env.TWILIO_AUTH_TOKEN  || '';
    if (accountSid && authToken) {
      authHeaders['Authorization'] = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    }
  }

  function streamUrl(url, headers, cb) {
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const opts = {
      hostname: url.hostname,
      // Honour the port from the URL. Hardcoding 443 made every non-standard
      // carrier/CDN host unreachable.
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers,
      agent: isHttps ? insecureAgent : undefined,
    };
    const req2 = transport.request(opts, cb);
    req2.on('error', (err) => {
      console.error('[recording-proxy] Error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Failed to fetch recording' });
    });
    req2.end();
  }

  streamUrl(
    parsedUrl,
    authHeaders,
    (proxyRes) => {
      // Follow 301/302 redirects (Twilio often redirects to S3/CDN)
      if ((proxyRes.statusCode === 301 || proxyRes.statusCode === 302) && proxyRes.headers.location) {
        proxyRes.resume();
        let redirectUrl;
        try { redirectUrl = new URL(proxyRes.headers.location); } catch { return res.status(502).end(); }
        return streamUrl(redirectUrl, {}, (redirectRes) => {
          res.setHeader('Content-Type', redirectRes.headers['content-type'] || 'audio/mpeg');
          res.setHeader('Accept-Ranges', 'bytes');
          if (redirectRes.headers['content-length']) res.setHeader('Content-Length', redirectRes.headers['content-length']);
          res.setHeader('Cache-Control', 'private, max-age=3600');
          res.statusCode = redirectRes.statusCode || 200;
          redirectRes.pipe(res);
        });
      }
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
      if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.statusCode = proxyRes.statusCode || 200;
      proxyRes.pipe(res);
    }
  );
}));

router.get('/', asyncHandler(async (req, res) => {
  const outpero = require('../services/outperoService');
  if (outpero.isConfigured()) {
    const calls = await outpero.listCalls();
    const conversations = calls.map((c) => ({
      call_id: c.id,
      phone_number: c.phone || c.to_number || '',
      direction: c.direction || 'outbound',
      status: c.status || 'completed',
      duration: c.duration_seconds || c.duration || 0,
      outcome: c.outcome || null,
      summary: c.summary || null,
      created_at: c.created_at || new Date().toISOString(),
      employee_id: c.employee_id,
      employee_name: c.employee_name || null,
    }));
    return res.json({ success: true, conversations });
  }
  const orgId = req.user.organization_id;
  const { q, employee_id, status, limit = 50, offset = 0 } = req.query;
  const where = ['calls.organization_id = ?'];
  const params = [orgId];
  if (employee_id) { where.push('calls.employee_id = ?'); params.push(parseInt(employee_id, 10)); }
  // Only a real duration marks an answered call; other terminal statuses are
  // filtered on their literal so the UI filter cannot silently return everything.
  if (status === 'completed') { where.push("calls.status = 'completed' AND calls.duration > 0"); }
  else if (status) { where.push('calls.status = ?'); params.push(status); }
  if (q) { where.push('(l.name LIKE ? OR calls.phone_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const whereSql = where.join(' AND ');
  const rows = await query(
    `SELECT calls.call_id, calls.phone_number, calls.direction, calls.status, calls.duration,
            calls.outcome, calls.sentiment, calls.intent, calls.summary, calls.recording_url,
            calls.created_at, calls.credits_used, calls.employee_id, e.name AS employee_name,
            l.name AS lead_name, l.company AS lead_company
     FROM calls
     LEFT JOIN ai_employees e ON e.id = calls.employee_id
     LEFT JOIN leads l ON l.id = calls.lead_id
     WHERE ${whereSql}
     ORDER BY calls.created_at DESC
     LIMIT ${parseInt(limit, 10)} OFFSET ${parseInt(offset, 10)}`,
    params
  );
  // The list player uses recording_proxy_url in preference to recording_url, but
  // only the detail endpoint was setting it. Without this the <audio> tag pointed
  // straight at the carrier URL, which for Twilio needs Basic auth and always
  // failed to load — no audio after the call.
  const conversations = rows.map((r) =>
    r.recording_url
      ? {
          ...r,
          recording_proxy_url: /^https?:\/\//i.test(r.recording_url) && !/vobiz\.ai|twilio\.com/i.test(r.recording_url)
            ? r.recording_url
            : `/api/conversations/${r.call_id}/recording`,
        }
      : r
  );
  const total = await query(`SELECT COUNT(*) AS c FROM calls LEFT JOIN leads l ON l.id = calls.lead_id WHERE ${whereSql}`, params);
  // Outcome chips must describe the rows the user is looking at, so the same
  // filter set (q / employee_id / status) applies here as in the list query.
  const byOutcome = await query(
    `SELECT calls.outcome, COUNT(*) AS c FROM calls LEFT JOIN leads l ON l.id = calls.lead_id WHERE ${whereSql} AND calls.outcome IS NOT NULL GROUP BY calls.outcome`,
    params
  );
  res.json({ success: true, conversations, total: total[0].c, byOutcome });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const call = await queryOne(
    `SELECT calls.*, e.name AS employee_name, e.avatar_url, e.role AS employee_role,
            l.name AS lead_name, l.phone AS lead_phone, l.company AS lead_company, l.email AS lead_email,
            l.location AS lead_location, camp.name AS campaign_name
     FROM calls
     LEFT JOIN ai_employees e ON e.id = calls.employee_id
     LEFT JOIN leads l ON l.id = calls.lead_id
     LEFT JOIN campaigns camp ON camp.id = calls.campaign_id
     WHERE calls.call_id = ? AND calls.organization_id = ?`,
    [req.params.id, req.user.organization_id]
  );
  if (!call) throw new AppError('Conversation not found', 404, 'NOT_FOUND');
  const [transcript, outcome, recordings] = await Promise.all([
    query('SELECT * FROM call_transcripts WHERE call_id = ? ORDER BY ts ASC', [call.id]),
    query('SELECT * FROM call_outcomes WHERE call_id = ?', [call.id]),
    query('SELECT * FROM call_recordings WHERE call_id = ?', [call.id]),
  ]);

  // Attach a proxy URL for the browser audio player (no auth needed)
  const finalCall = { ...call, transcript, analysis: outcome[0] || null, recordings };
  if (finalCall.recording_url) {
    finalCall.recording_proxy_url = /^https?:\/\//i.test(finalCall.recording_url) && !/vobiz\.ai|twilio\.com/i.test(finalCall.recording_url)
      ? finalCall.recording_url
      : `/api/conversations/${req.params.id}/recording`;
  }

  res.json({ success: true, conversation: finalCall });
}));

// -----------------------------------------------------------------------------
// Clear All Conversations for Organization (Clear Total)
// -----------------------------------------------------------------------------
router.delete('/', asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;

  await update('DELETE FROM call_transcripts WHERE call_id IN (SELECT id FROM calls WHERE organization_id = ?)', [orgId]).catch(() => {});
  await update('DELETE FROM call_recordings WHERE call_id IN (SELECT id FROM calls WHERE organization_id = ?)', [orgId]).catch(() => {});
  await update('DELETE FROM call_events WHERE call_id IN (SELECT id FROM calls WHERE organization_id = ?)', [orgId]).catch(() => {});
  await update('DELETE FROM call_outcomes WHERE call_id IN (SELECT id FROM calls WHERE organization_id = ?)', [orgId]).catch(() => {});
  const deleted = await update('DELETE FROM calls WHERE organization_id = ?', [orgId]);

  if (audit) await audit(req, 'conversation.clear_all', 'call', null, { count: deleted.affectedRows }).catch(() => {});
  res.json({ success: true, message: 'All conversations cleared', deletedCount: deleted.affectedRows || 0 });
}));

router.post('/clear', asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;

  await update('DELETE FROM call_transcripts WHERE call_id IN (SELECT id FROM calls WHERE organization_id = ?)', [orgId]).catch(() => {});
  await update('DELETE FROM call_recordings WHERE call_id IN (SELECT id FROM calls WHERE organization_id = ?)', [orgId]).catch(() => {});
  await update('DELETE FROM call_events WHERE call_id IN (SELECT id FROM calls WHERE organization_id = ?)', [orgId]).catch(() => {});
  await update('DELETE FROM call_outcomes WHERE call_id IN (SELECT id FROM calls WHERE organization_id = ?)', [orgId]).catch(() => {});
  const deleted = await update('DELETE FROM calls WHERE organization_id = ?', [orgId]);

  if (audit) await audit(req, 'conversation.clear_all', 'call', null, { count: deleted.affectedRows }).catch(() => {});
  res.json({ success: true, message: 'All conversations cleared', deletedCount: deleted.affectedRows || 0 });
}));

// -----------------------------------------------------------------------------
// Bulk Delete Conversations
// -----------------------------------------------------------------------------
router.post('/bulk-delete', asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
  if (ids.length === 0) throw new AppError('No conversation IDs provided', 400, 'VALIDATION');

  const placeholders = ids.map(() => '?').join(',');
  const calls = await query(
    `SELECT id, call_id FROM calls WHERE organization_id = ? AND (call_id IN (${placeholders}) OR id IN (${placeholders}))`,
    [orgId, ...ids, ...(ids.map(x => parseInt(x, 10) || -1))]
  );

  if (calls.length > 0) {
    const dbIds = calls.map((c) => c.id);
    const dbPlaceholders = dbIds.map(() => '?').join(',');
    await update(`DELETE FROM call_transcripts WHERE call_id IN (${dbPlaceholders})`, dbIds).catch(() => {});
    await update(`DELETE FROM call_recordings WHERE call_id IN (${dbPlaceholders})`, dbIds).catch(() => {});
    await update(`DELETE FROM call_events WHERE call_id IN (${dbPlaceholders})`, dbIds).catch(() => {});
    await update(`DELETE FROM call_outcomes WHERE call_id IN (${dbPlaceholders})`, dbIds).catch(() => {});
    await update(`DELETE FROM calls WHERE id IN (${dbPlaceholders})`, dbIds);
  }

  if (audit) await audit(req, 'conversation.bulk_delete', 'call', null, { count: calls.length }).catch(() => {});
  res.json({ success: true, count: calls.length });
}));

// -----------------------------------------------------------------------------
// Delete Single Conversation
// -----------------------------------------------------------------------------
router.delete('/:id', asyncHandler(async (req, res) => {
  const orgId = req.user.organization_id;
  const param = req.params.id;
  const call = await queryOne(
    'SELECT id, call_id FROM calls WHERE (call_id = ? OR id = ?) AND organization_id = ?',
    [param, parseInt(param, 10) || -1, orgId]
  );
  if (!call) throw new AppError('Conversation not found', 404, 'NOT_FOUND');

  await update('DELETE FROM call_transcripts WHERE call_id = ?', [call.id]).catch(() => {});
  await update('DELETE FROM call_recordings WHERE call_id = ?', [call.id]).catch(() => {});
  await update('DELETE FROM call_events WHERE call_id = ?', [call.id]).catch(() => {});
  await update('DELETE FROM call_outcomes WHERE call_id = ?', [call.id]).catch(() => {});
  await update('DELETE FROM calls WHERE id = ?', [call.id]);

  if (audit) await audit(req, 'conversation.delete', 'call', call.call_id).catch(() => {});
  res.json({ success: true, message: 'Conversation deleted' });
}));

module.exports = router;