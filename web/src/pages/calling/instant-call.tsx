import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Coins,
  Mic,
  PhoneCall,
  PhoneOff,
  PhoneOutgoing,
  Sparkles,
  User,
  XCircle,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { api, ApiClientError, getApiBase } from '@/lib/api';
import { useEmployees } from '@/hooks/queries';
import { useAuth } from '@/context/AuthContext';
import { useRealtimeEvent } from '@/hooks/useRealtime';
import { cn, formatDuration, normalizePhone, titleCase } from '@/lib/utils';

type CallState =
  | 'idle'
  | 'preparing'
  | 'calling'
  | 'ringing'
  | 'connected'
  | 'ai_speaking'
  | 'customer_speaking'
  | 'completed'
  | 'failed';

interface LiveMsg {
  id: number;
  speaker: 'ai' | 'customer';
  text: string;
}

// Three stages, because that is actually what a caller observes. The previous
// seven pills included ai_speaking / customer_speaking, which alternate rather
// than advance, so "completed" could never light up on its own.
const STAGES = [
  { key: 'connecting', label: 'Connecting', states: ['preparing', 'calling', 'ringing'] },
  { key: 'talking', label: 'In conversation', states: ['connected', 'ai_speaking', 'customer_speaking'] },
  { key: 'ended', label: 'Call ended', states: ['completed'] },
] as const;

const STATE_LABEL: Record<CallState, string> = {
  idle: 'Ready',
  preparing: 'Preparing',
  calling: 'Calling',
  ringing: 'Ringing',
  connected: 'Connected',
  ai_speaking: 'AI is speaking',
  customer_speaking: 'Customer is speaking',
  completed: 'Completed',
  failed: 'Failed',
};

// Positive / negative outcomes get a colour so the result is readable at a glance
// instead of being a raw slug like "not_interested".
const OUTCOME_TONE: Record<string, 'success' | 'destructive' | 'warning' | 'secondary'> = {
  interested: 'success',
  converted: 'success',
  callback: 'warning',
  follow_up: 'warning',
  busy: 'secondary',
  no_answer: 'secondary',
  not_interested: 'destructive',
  dnd: 'destructive',
  wrong_number: 'destructive',
  failed: 'destructive',
};

function stageIndexFor(state: CallState): number {
  if (state === 'failed') return 1;
  const idx = STAGES.findIndex((s) => (s.states as readonly string[]).includes(state));
  return idx === -1 ? -1 : idx;
}

export function InstantCallPage() {
  const { data: empData } = useEmployees();
  const { wallet, setWallet } = useAuth();
  const toast = useToast();
  const [employeeId, setEmployeeId] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [purpose, setPurpose] = useState('');
  const [callState, setCallState] = useState<CallState>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<LiveMsg[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<{ outcome?: string; summary?: string; duration?: number; credits?: number; recordingUrl?: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const idRef = useRef(0);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const lastEndedAtRef = useRef<number>(0);
  const isDialingRef = useRef<boolean>(false);

  const employees = empData?.employees ?? [];
  const selected = employees.find((e) => e.id === Number(employeeId));
  const normalizedPhone = normalizePhone(phone);
  const inProgress = callState !== 'idle' && callState !== 'completed' && callState !== 'failed';

  // Follow the conversation as it happens. Without this the newest lines land
  // below the fold and the operator has to scroll manually on every utterance.
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  useEffect(() => {
    if (!callId) return;
    if (['completed', 'failed'].includes(callState)) return;
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [callId, callState]);

  useRealtimeEvent('call.transcript', (data) => {
    if (data.callId !== callId) return;
    const speaker = data.speaker as 'ai' | 'customer';
    const text = String(data.text ?? '');
    if (!text) return;
    setTranscript((prev) => [...prev, { id: ++idRef.current, speaker, text }]);
  });

  useRealtimeEvent('call.ai_started', (data) => {
    if (data.callId !== callId) return;
    setCallState('ai_speaking');
    if (data.text) setTranscript((prev) => [...prev, { id: ++idRef.current, speaker: 'ai', text: String(data.text) }]);
  });

  useRealtimeEvent('call.user_started', (data) => {
    if (data.callId !== callId) return;
    setCallState('customer_speaking');
    if (data.text) setTranscript((prev) => [...prev, { id: ++idRef.current, speaker: 'customer', text: String(data.text) }]);
  });

  useRealtimeEvent('call.created', (d) => {
    if (d.callId === callId) setCallState('preparing');
  });
  useRealtimeEvent('call.ringing', (d) => {
    if (d.callId === callId) setCallState('ringing');
  });
  useRealtimeEvent('call.answered', (d) => {
    if (d.callId === callId) setCallState('connected');
  });

  useRealtimeEvent('call.completed', (d) => {
    if (d.callId !== callId) return;
    lastEndedAtRef.current = Date.now();
    setCallState('completed');
    setResult({
      outcome: d.outcome ? String(d.outcome) : undefined,
      duration: typeof d.duration === 'number' ? d.duration : elapsed,
      credits: typeof d.creditsUsed === 'number' ? d.creditsUsed : undefined,
      recordingUrl: d.recordingUrl ? String(d.recordingUrl) : undefined,
    });
    if (typeof d.creditsUsed === 'number' && wallet) {
      setWallet({ ...wallet, balance: Math.max(0, wallet.balance - d.creditsUsed) });
    }
  });

  useRealtimeEvent('call.recording', (d) => {
    if (d.callId === callId && d.recordingUrl) {
      setResult((prev) => ({
        ...(prev || {}),
        recordingUrl: String(d.recordingUrl),
      }));
    }
  });

  useRealtimeEvent('call.failed', (d) => {
    if (d.callId !== callId) return;
    lastEndedAtRef.current = Date.now();
    setCallState('failed');
    setResult({ summary: d.error ? String(d.error) : 'The call could not be completed.' });
  });

  // Fallback polling in case WS not connected
  useEffect(() => {
    if (!callId || ['completed', 'failed'].includes(callState)) return;
    const t = window.setInterval(async () => {
      try {
        const res = await api.get<{ call: { status: string; outcome?: string; summary?: string; duration: number; credits_used?: number; recording_url?: string } }>(`/calls/${callId}`);
        const c = res.call;
        if (c.status === 'completed') {
          lastEndedAtRef.current = Date.now();
          setCallState('completed');
          setResult({ outcome: c.outcome, summary: c.summary, duration: c.duration, credits: c.credits_used, recordingUrl: c.recording_url });
        } else if (c.status === 'failed') {
          lastEndedAtRef.current = Date.now();
          setCallState('failed');
        }
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, [callId, callState]);

  const estimatedCredits = selected ? Math.max(1, Math.min(selected.max_call_duration ?? 300, 60) / 60) * 2 : 0;

  // Say *why* the button is disabled, instead of leaving the operator guessing.
  const blockers: string[] = [];
  if (!selected) blockers.push('Pick an AI employee');
  if (!phone.trim()) blockers.push('Enter a phone number');
  else if (normalizedPhone.length < 12) blockers.push('That phone number looks too short');
  const canCall = blockers.length === 0;

  const startCall = async () => {
    if (isDialingRef.current || starting || inProgress) return;
    if (Date.now() - lastEndedAtRef.current < 2500) {
      toast.info('Please wait a moment before starting a new call.');
      return;
    }
    if (!employeeId || isNaN(Number(employeeId))) {
      toast.error('Select an AI employee');
      return;
    }
    if (!phone.trim()) {
      toast.error('Enter a phone number');
      return;
    }
    isDialingRef.current = true;
    setStarting(true);
    setTranscript([]);
    setResult(null);
    setElapsed(0);
    try {
      const res = await api.post<{
        success: boolean;
        call: { callId: string; status: string; estimatedCredits: number; walletBalance: number };
      }>('/calls/instant', {
        employee_id: Number(employeeId),
        phone: normalizePhone(phone),
        purpose,
        name,
      });
      setCallId(res.call.callId);
      setCallState('preparing');
      toast.success('Call initiated', `Estimated ${res.call.estimatedCredits} credits`);
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'Call failed to start';
      toast.error('Could not start call', msg);
      setCallState('failed');
    } finally {
      setStarting(false);
      setTimeout(() => {
        isDialingRef.current = false;
      }, 1500);
    }
  };

  const hangup = async () => {
    if (!callId) return;
    lastEndedAtRef.current = Date.now();
    try {
      await api.post(`/calls/${callId}/hangup`);
    } catch {
      /* ignore */
    }
    setCallState('completed');
    setResult((r) => ({ ...r, duration: elapsed }));
  };

  const reset = () => {
    setCallId(null);
    setCallState('idle');
    setTranscript([]);
    setResult(null);
    setElapsed(0);
  };

  const stageIndex = stageIndexFor(callState);
  const speakingLabel =
    callState === 'ai_speaking' ? `${selected?.name ?? 'AI'} is speaking` : callState === 'customer_speaking' ? 'Customer is speaking' : null;

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div>
        <h1 className="text-xl font-bold">Instant Lead Call</h1>
        <p className="text-sm text-muted-foreground">
          Ring one lead right now and watch the conversation live. For bulk calling, use Campaigns instead.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        {/* ---------------- Setup ---------------- */}
        <Card className="lg:col-span-2 h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <PhoneOutgoing className="h-4 w-4" /> Call setup
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Who is calling */}
            <div className="space-y-1.5">
              <Label htmlFor="emp">Which AI employee?</Label>
              <Select
                id="emp"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                disabled={inProgress}
              >
                <option value="">Select an employee…</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.role}
                  </option>
                ))}
              </Select>
              {selected ? (
                <div className="mt-2 flex items-center gap-3 rounded-lg border bg-muted/30 p-2.5">
                  <Avatar name={selected.name} size="sm" />
                  <div className="min-w-0 text-xs">
                    <p className="truncate font-semibold text-foreground">{selected.name}</p>
                    <p className="truncate text-muted-foreground">
                      {selected.language} · calls for up to {formatDuration(selected.max_call_duration ?? 300)}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">No employee selected yet.</p>
              )}
            </div>

            {/* Who gets called */}
            <div className="space-y-3 border-t pt-4">
              <div className="space-y-1.5">
                <Label htmlFor="phone">Phone number</Label>
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="98765 43210"
                  inputMode="tel"
                  disabled={inProgress}
                  className={cn(phone.trim() && normalizedPhone.length < 12 && 'border-destructive focus-visible:ring-destructive')}
                />
                {phone.trim() ? (
                  normalizedPhone.length < 12 ? (
                    <p className="flex items-center gap-1 text-[11px] text-destructive">
                      <AlertCircle className="h-3 w-3" /> That doesn&apos;t look like a full number yet.
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Will dial <span className="font-mono font-semibold text-foreground">{normalizedPhone}</span>
                    </p>
                  )
                ) : (
                  <p className="text-[11px] text-muted-foreground">Indian 10-digit numbers are accepted.</p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="lname">Lead name</Label>
                  <Input
                    id="lname"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Optional"
                    disabled={inProgress}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="purpose">Reason for the call</Label>
                  <Input
                    id="purpose"
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder="Optional"
                    disabled={inProgress}
                  />
                </div>
              </div>
            </div>

            {/* Cost */}
            <div className="space-y-2 border-t pt-4">
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Coins className="h-4 w-4" /> Estimated cost
                </span>
                <span className="font-semibold">
                  {selected ? `~${estimatedCredits.toFixed(0)} credits` : '—'}
                </span>
              </div>
              {wallet ? (
                <p className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Wallet className="h-3 w-3" /> Wallet balance
                  </span>
                  <span className="font-semibold text-foreground">{wallet.balance} credits</span>
                </p>
              ) : null}
            </div>

            {/* Action */}
            {inProgress ? (
              <Button className="w-full" size="lg" variant="destructive" onClick={hangup}>
                <PhoneOff className="h-4 w-4" /> End call
              </Button>
            ) : callState === 'completed' || callState === 'failed' ? (
              <Button className="w-full" size="lg" variant="outline" onClick={reset}>
                <Sparkles className="h-4 w-4" /> Start another call
              </Button>
            ) : (
              <Button className="w-full" size="lg" onClick={startCall} loading={starting} disabled={!canCall}>
                <PhoneCall className="h-4 w-4" /> Call now
              </Button>
            )}

            {/* Explains the disabled state instead of leaving it a mystery */}
            {!canCall && !inProgress && callState === 'idle' ? (
              <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                To start: {blockers.join(' and ').toLowerCase()}.
              </p>
            ) : null}
          </CardContent>
        </Card>

        {/* ---------------- Live call ---------------- */}
        <div className="space-y-4 lg:col-span-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
              <CardTitle>Call progress</CardTitle>
              {callId ? (
                <Badge variant={callState === 'failed' ? 'destructive' : callState === 'completed' ? 'success' : 'warning'}>
                  {STATE_LABEL[callState]}
                </Badge>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {callState === 'idle' ? (
                <div className="rounded-xl border border-dashed px-5 py-8 text-center">
                  <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <PhoneOutgoing className="h-5 w-5" />
                  </span>
                  <p className="mt-3 text-sm font-semibold">No call running</p>
                  <ol className="mx-auto mt-2 max-w-xs space-y-1 text-left text-[11px] text-muted-foreground">
                    <li>1. Pick the AI employee who should call</li>
                    <li>2. Enter the lead&apos;s phone number</li>
                    <li>3. Press “Call now” and follow along</li>
                  </ol>
                </div>
              ) : (
                <>
                  {/* Stages */}
                  <ol className="flex items-stretch gap-2">
                    {STAGES.map((s, i) => {
                      const done = stageIndex > i;
                      const active = stageIndex === i;
                      const failedHere = callState === 'failed' && i === stageIndex;
                      return (
                        <li key={s.key} className="flex flex-1 items-center gap-2">
                          <div
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-2 transition',
                              failedHere
                                ? 'border-destructive/40 bg-destructive/10'
                                : active
                                  ? 'border-primary/50 bg-primary/10'
                                  : done
                                    ? 'border-emerald-500/40 bg-emerald-500/10'
                                    : 'border-border bg-muted/20',
                            )}
                          >
                            <span
                              className={cn(
                                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                                failedHere
                                  ? 'bg-destructive text-destructive-foreground'
                                  : active
                                    ? 'bg-primary text-primary-foreground'
                                    : done
                                      ? 'bg-emerald-500 text-white'
                                      : 'bg-muted text-muted-foreground',
                              )}
                            >
                              {done ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
                            </span>
                            <span
                              className={cn(
                                'truncate text-xs font-semibold',
                                active || done ? 'text-foreground' : 'text-muted-foreground',
                              )}
                            >
                              {s.label}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ol>

                  {/* Live timer + who is talking */}
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 px-4 py-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Duration</p>
                      <p className="font-mono text-2xl font-bold tabular-nums leading-tight">{formatDuration(elapsed)}</p>
                    </div>
                    <div className="text-right">
                      {speakingLabel ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                          <Mic className="h-3 w-3 animate-pulse" /> {speakingLabel}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
                          {STATE_LABEL[callState]}
                        </span>
                      )}
                      {callId ? <p className="mt-1 font-mono text-[10px] text-muted-foreground">ID {callId.slice(0, 12)}</p> : null}
                    </div>
                  </div>

                  {callState === 'failed' ? (
                    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{result?.summary ?? 'The call failed.'}</span>
                    </div>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          {/* Transcript */}
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
              <CardTitle>Conversation</CardTitle>
              {transcript.length > 0 ? (
                <Badge variant="muted">{transcript.length} lines</Badge>
              ) : null}
            </CardHeader>
            <CardContent>
              <div ref={transcriptRef} className="h-64 space-y-3 overflow-y-auto pr-1 scrollbar-thin">
                {transcript.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <User className="h-4 w-4" />
                    </span>
                    <p className="text-xs text-muted-foreground">
                      {inProgress
                        ? 'Waiting for the call to connect. Words appear here as they are spoken.'
                        : 'The live transcript will appear here once the call starts.'}
                    </p>
                  </div>
                ) : (
                  transcript.map((m) => (
                    <div key={m.id} className={cn('flex', m.speaker === 'customer' ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cn(
                          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm',
                          m.speaker === 'customer'
                            ? 'rounded-br-sm bg-primary text-primary-foreground'
                            : 'rounded-bl-sm border bg-muted/60',
                        )}
                      >
                        <p className="mb-0.5 text-[11px] font-semibold opacity-70">
                          {m.speaker === 'customer' ? 'Customer' : selected?.name || 'AI'}
                        </p>
                        <p className="whitespace-pre-wrap break-words">{m.text}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Result */}
          {result && (callState === 'completed' || callState === 'failed') ? (
            <Card className={cn(callState === 'failed' ? 'border-destructive/30' : 'border-emerald-500/30')}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  {callState === 'failed' ? (
                    <XCircle className="h-4 w-4 text-destructive" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  )}
                  {callState === 'failed' ? 'Call failed' : 'Call completed'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-lg border px-3 py-2.5">
                    <p className="text-[11px] text-muted-foreground">Outcome</p>
                    {result.outcome ? (
                      <Badge variant={OUTCOME_TONE[result.outcome] ?? 'secondary'} className="mt-1">
                        {titleCase(result.outcome)}
                      </Badge>
                    ) : (
                      <p className="mt-0.5 text-sm font-medium">—</p>
                    )}
                  </div>
                  <div className="rounded-lg border px-3 py-2.5">
                    <p className="text-[11px] text-muted-foreground">Talk time</p>
                    <p className="mt-0.5 font-mono text-sm font-semibold">{formatDuration(result.duration ?? elapsed)}</p>
                  </div>
                  <div className="rounded-lg border px-3 py-2.5">
                    <p className="text-[11px] text-muted-foreground">Credits used</p>
                    <p className="mt-0.5 font-mono text-sm font-semibold">
                      {result.credits ?? (selected ? estimatedCredits.toFixed(0) : '—')}
                    </p>
                  </div>
                  <div className="rounded-lg border px-3 py-2.5">
                    <p className="text-[11px] text-muted-foreground">Recording</p>
                    <p className="mt-0.5 text-sm font-medium">
                      {result.recordingUrl ? (
                        <a
                          className="text-primary underline"
                          href={result.recordingUrl.startsWith('http') ? result.recordingUrl : `${getApiBase()}${result.recordingUrl}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Listen
                        </a>
                      ) : (
                        '—'
                      )}
                    </p>
                  </div>
                </div>

                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Summary</p>
                  <p className="mt-1 text-sm">{result.summary ?? 'The call finished without a written summary.'}</p>
                </div>

                {callId ? (
                  <Link
                    to={`/results/conversations/${callId}`}
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                  >
                    View full conversation analysis →
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}