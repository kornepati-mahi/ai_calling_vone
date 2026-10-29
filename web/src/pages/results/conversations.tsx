import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  AudioLines,
  Bot,
  Download,
  Filter,
  MessageSquareText,
  Mic,
  RefreshCw,
  Search,
  Send,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { StatusBadge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TableSkeleton, Skeleton } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useConversation, useConversations, useEmployees } from '@/hooks/queries';
import { useRealtimeEvent } from '@/hooks/useRealtime';
import { cn, formatDateTime, formatDuration, titleCase, formatPhoneDisplay } from '@/lib/utils';
import { api, ApiClientError, fetchObjectUrl, getApiBase } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import type { Call, CallOutcome, TranscriptRow } from '@/types';

const LIMIT = 25;
const OUTCOME_COLORS = ['#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#06b6d4', '#ec4899'];
// Terminal call statuses persisted by the telephony/call services; the list
// query filters on these exact literals.
const CALL_STATUSES = ['completed', 'failed', 'busy', 'no_answer', 'wrong_number'];
const QUALIFIED_OUTCOMES = new Set(['interested', 'converted']);

export function ConversationsPage({ detail }: { detail?: boolean }) {
  const { id } = useParams();

  if (detail && id) {
    return <ConversationDetail conversationId={id} />;
  }
  return <ConversationsList />;
}

function ConversationsList() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: empData } = useEmployees();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [status, setStatus] = useState('');

  // Bulk selection and delete states
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useConversations({
    q: debounced,
    employee_id: employeeId,
    status,
    limit: LIMIT,
    offset: (page - 1) * LIMIT,
  });

  // Post-call results (outcome, sentiment, recording) arrive after the call has
  // already closed, so the list is refreshed when the backend finishes scoring
  // it. 'call.transcript' is deliberately excluded: it fires on every spoken
  // turn, so subscribing to it refetched the whole list per utterance.
  useRealtimeEvent(
    ['call.analyzed', 'call.completed', 'call.failed', 'call.recording'],
    () => { void queryClient.invalidateQueries({ queryKey: ['conversations'] }); }
  );

  const conversations = data?.conversations ?? [];
  const total = data?.total ?? 0;
  const byOutcome = data?.byOutcome ?? [];

  // Delete a single conversation
  const handleDeleteSingle = async (callId: string, leadName?: string | null) => {
    if (!confirm(`Delete conversation with ${leadName || 'this contact'}? This removes its call recording and transcript.`)) return;
    setDeletingId(callId);
    try {
      await api.del(`/conversations/${callId}`);
      toast.success('Conversation deleted');
      setSelectedIds((prev) => prev.filter((id) => id !== callId));
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      toast.error('Failed to delete conversation', err instanceof ApiClientError ? err.message : '');
    } finally {
      setDeletingId(null);
    }
  };

  // Clear total conversations for this organization
  const handleClearAll = async () => {
    setClearingAll(true);
    try {
      await api.del('/conversations');
      toast.success('All conversations cleared successfully');
      setSelectedIds([]);
      setShowClearModal(false);
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      toast.error('Failed to clear conversations', err instanceof ApiClientError ? err.message : '');
    } finally {
      setClearingAll(false);
    }
  };

  // Delete selected conversations
  const handleDeleteSelected = async () => {
    if (selectedIds.length === 0) return;
    if (!confirm(`Delete ${selectedIds.length} selected conversation${selectedIds.length > 1 ? 's' : ''}? This removes recordings and transcripts.`)) return;
    setClearingAll(true);
    try {
      await api.post('/conversations/bulk-delete', { ids: selectedIds });
      toast.success(`Deleted ${selectedIds.length} conversations`);
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (err) {
      toast.error('Failed to delete selected conversations', err instanceof ApiClientError ? err.message : '');
    } finally {
      setClearingAll(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">All Conversations</h1>
          <p className="text-sm text-muted-foreground">{total} conversation{total === 1 ? '' : 's'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selectedIds.length > 0 && (
            <Button
              variant="destructive"
              size="sm"
              loading={clearingAll}
              onClick={handleDeleteSelected}
              className="gap-1.5 h-8 text-xs font-semibold cursor-pointer shadow-xs"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete Selected ({selectedIds.length})
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={total === 0 || clearingAll}
            onClick={() => setShowClearModal(true)}
            className="gap-1.5 h-8 text-xs font-semibold text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/60 cursor-pointer shadow-xs"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" /> Clear All Conversations
          </Button>
        </div>
      </div>

      {byOutcome.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {byOutcome.map((o, i) => (
            <span
              key={o.outcome}
              className="flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground"
            >
              <span className="h-2 w-2 rounded-full" style={{ background: OUTCOME_COLORS[i % OUTCOME_COLORS.length] }} />
              {titleCase(o.outcome)} ({o.c})
            </span>
          ))}
        </div>
      ) : null}

      <Card>
        <CardContent className="p-3.5 sm:p-4">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9 w-full"
                placeholder="Search name or phone…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <Select className="w-auto min-w-[130px]" value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); setPage(1); }}>
                <option value="">All employees</option>
                {empData?.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </Select>
              <Select className="w-auto min-w-[120px]" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
                <option value="">All statuses</option>
                {CALL_STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
              </Select>
              {(status || employeeId || search) ? (
                <Button variant="ghost" size="sm" onClick={() => { setStatus(''); setEmployeeId(''); setSearch(''); }}>
                  <Filter className="h-3.5 w-3.5" /> Clear
                </Button>
              ) : null}
            </div>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <TableSkeleton rows={8} cols={6} />
      ) : conversations.length === 0 ? (
        <EmptyState
          icon={<MessageSquareText className="h-6 w-6" />}
          title="No conversations yet"
          description={total === 0 ? 'Your AI call transcripts and recordings will appear here.' : 'Try changing your filters.'}
        />
      ) : (
        <Card>
          <CardContent className="p-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10 text-center">
                    <input
                      type="checkbox"
                      checked={conversations.length > 0 && selectedIds.length === conversations.length}
                      onChange={() => {
                        if (selectedIds.length === conversations.length) {
                          setSelectedIds([]);
                        } else {
                          setSelectedIds(conversations.map((c) => c.call_id));
                        }
                      }}
                      className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                      title="Select all on this page"
                    />
                  </TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Employee</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Sentiment</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {conversations.map((c) => {
                  const isChecked = selectedIds.includes(c.call_id);
                  const pInfo = formatPhoneDisplay(c.phone_number);
                  return (
                    <TableRow
                      key={c.call_id}
                      className={`cursor-pointer transition-colors ${isChecked ? 'bg-primary/5' : ''}`}
                      onClick={() => navigate(`/results/conversations/${c.call_id}`)}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()} className="text-center">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            setSelectedIds((prev) =>
                              isChecked ? prev.filter((id) => id !== c.call_id) : [...prev, c.call_id]
                            );
                          }}
                          className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
                        />
                      </TableCell>
                      <TableCell className="font-medium text-foreground">{c.lead_name || 'Unknown'}</TableCell>
                      <TableCell className="text-sm">{c.employee_name || '—'}</TableCell>
                      <TableCell className="text-sm font-mono whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 dark:bg-emerald-500/20 border border-emerald-500/30 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 select-none">
                            <span>🇮🇳</span>
                            <span>+91</span>
                          </span>
                          <span className="font-semibold text-foreground tracking-wide font-mono">
                            {pInfo.number || c.phone_number}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{formatDuration(c.duration)}</TableCell>
                      <TableCell><StatusBadge status={c.outcome ?? undefined} /></TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.sentiment || '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{formatDateTime(c.created_at)}</TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()} className="text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={deletingId === c.call_id}
                          onClick={() => handleDeleteSingle(c.call_id, c.lead_name)}
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                          title="Delete conversation"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="p-3">
              <Pagination page={page} limit={LIMIT} total={total} onPageChange={setPage} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Confirmation Dialog: Clear All Conversations */}
      <Dialog open={showClearModal} onOpenChange={setShowClearModal}>
        <DialogHeader>
          <div className="flex items-center gap-2 text-destructive font-bold text-base">
            <AlertTriangle className="h-5 w-5" />
            <DialogTitle>Clear All Conversations</DialogTitle>
          </div>
        </DialogHeader>
        <div className="py-3 text-xs text-muted-foreground space-y-2">
          <p>
            Are you sure you want to permanently delete <strong>all {total} conversation records</strong> in your organization?
          </p>
          <p className="rounded-lg bg-destructive/10 border border-destructive/20 p-2.5 text-destructive leading-relaxed">
            ⚠️ This action is irreversible. All recorded voice call logs, audio playback links, transcripts, and AI analysis data will be permanently removed.
          </p>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => setShowClearModal(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            loading={clearingAll}
            onClick={handleClearAll}
            className="gap-1.5 font-semibold cursor-pointer"
          >
            <Trash2 className="h-4 w-4" /> Yes, Clear All ({total})
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function ConversationDetail({ conversationId }: { conversationId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, refetch } = useConversation(conversationId);
  const call = data?.conversation;
  const [deleting, setDeleting] = useState(false);

  const handleDeleteDetail = async () => {
    if (!call) return;
    if (!confirm(`Delete conversation with ${call.lead_name || 'this contact'}? This removes its recording and transcript.`)) return;
    setDeleting(true);
    try {
      await api.del(`/conversations/${call.call_id}`);
      toast.success('Conversation deleted');
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      navigate('/results/conversations');
    } catch (err) {
      toast.error('Failed to delete conversation', err instanceof ApiClientError ? err.message : '');
      setDeleting(false);
    }
  };

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64" />
          <Skeleton className="h-96 lg:col-span-2" />
        </div>
      </div>
    );
  }

  if (isError || !call) {
    return <ErrorState title="Conversation not found" onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-4">
      <button onClick={() => navigate('/results/conversations')} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <Send className="h-4 w-4 rotate-180" /> All conversations
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={call.lead_name ?? 'Unknown'} size="lg" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold">{call.lead_name || 'Unknown'}</h1>
              <StatusBadge status={call.outcome ?? call.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              {call.phone_number} · {call.employee_name ?? 'AI employee'} · {formatDateTime(call.created_at)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => refetch()}><RefreshCw className="h-4 w-4" /> Refresh</Button>
          <Button
            variant="outline"
            loading={deleting}
            onClick={handleDeleteDetail}
            className="text-destructive hover:bg-destructive/10 border-destructive/30 hover:border-destructive/60 cursor-pointer"
          >
            <Trash2 className="h-4 w-4 mr-1" /> Delete
          </Button>
        </div>
      </div>

      <CallInfoBar call={call} />

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Transcript */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between border-b">
            <CardTitle className="flex items-center gap-2">
              <MessageSquareText className="h-4 w-4" /> Transcript
            </CardTitle>
            {call.transcript?.length ? <span className="text-xs text-muted-foreground">{call.transcript.length} turns</span> : null}
          </CardHeader>
          <CardContent className="p-0">
            <div className="h-[30rem] space-y-3 overflow-y-auto p-5 scrollbar-thin">
              {(call.transcript ?? []).length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
                  <Mic className="mb-2 h-8 w-8" />
                  No transcript recorded for this call.
                </div>
              ) : (
                (call.transcript as TranscriptRow[]).map((t) => (
                  <div key={t.id} className={cn('flex', t.speaker === 'customer' ? 'justify-end' : 'justify-start')}>
                    <div
                      className={cn(
                        'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm',
                        t.speaker === 'customer' ? 'rounded-br-sm bg-primary text-primary-foreground' : 'rounded-bl-sm bg-muted',
                      )}
                    >
                      <p className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold opacity-70">
                        {t.speaker === 'customer' ? <Send className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                        {t.speaker === 'customer' ? 'Customer' : (call.employee_name || 'AI')}
                        {t.ts ? <span className="font-normal opacity-60">· {formatDuration(t.ts)}</span> : null}
                      </p>
                      <p className="whitespace-pre-wrap">{t.text}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        {/* Analysis */}
        <div className="space-y-4">
          <AIAnalysis call={call} />
          {(call.recording_url || call.recording_proxy_url || (call.recordings?.length ?? 0) > 0) ? (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><AudioLines className="h-4 w-4" /> Recording</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <RecordingPlayer call={call} />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The proxy route is tenant-scoped, so the audio has to be fetched with the
 * bearer token and handed to the player as an object URL. The blob is revoked
 * on unmount or when the call changes, otherwise switching between
 * conversations leaks every recording into memory.
 */
function RecordingPlayer({ call }: { call: Call }) {
  const toast = useToast();
  const proxyPath = call.recording_proxy_url;
  const directUrl = call.recording_url ?? call.recordings?.[0]?.url ?? null;
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    setSrc(null);

    // Direct public URL (InsForge cloud storage, CDN) that doesn't need carrier auth
    if (directUrl && /^https?:\/\//i.test(directUrl) && !/vobiz\.ai|twilio\.com/i.test(directUrl)) {
      setSrc(directUrl);
      return () => { revoked = true; };
    }

    if (!proxyPath && !directUrl) return () => { revoked = true; };

    const targetPath = proxyPath || directUrl!;
    setLoading(true);
    fetchObjectUrl(targetPath)
      .then((url) => {
        objectUrl = url;
        if (revoked) {
          URL.revokeObjectURL(url);
          return;
        }
        setSrc(url);
      })
      .catch((err: unknown) => {
        if (directUrl && /^https?:\/\//i.test(directUrl) && !revoked) {
          setSrc(directUrl);
        } else if (directUrl && directUrl.startsWith('/api/') && !revoked) {
          const apiBase = getApiBase();
          setSrc(`${apiBase}${directUrl}`);
        } else if (!revoked) {
          toast.error('Recording unavailable', err instanceof Error ? err.message : undefined);
        }
      })
      .finally(() => {
        if (!revoked) setLoading(false);
      });

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyPath, directUrl, call.call_id]);

  if (loading) {
    return <div className="flex items-center gap-2 text-xs text-muted-foreground"><Skeleton className="h-10 w-full" /></div>;
  }
  if (!src) {
    return <p className="text-xs text-muted-foreground">Recording could not be loaded.</p>;
  }

  return (
    <>
      <audio src={src} className="w-full" controls preload="metadata" />
      <div className="flex flex-wrap gap-2">
        <a href={src} download target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm">
            <Download className="h-3.5 w-3.5" /> {formatDuration(call.duration ?? 0)}
          </Button>
        </a>
      </div>
    </>
  );
}

function CallInfoBar({ call }: { call: Call }) {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Call ID', value: call.call_id },
    { label: 'Direction', value: titleCase(call.direction) || '—' },
    { label: 'Status', value: call.status || '—' },
    { label: 'Duration', value: formatDuration(call.duration) },
    { label: 'Campaign', value: call.campaign_name || '—' },
    { label: 'Lead company', value: call.lead_company || '—' },
    { label: 'Credits used', value: String(call.credits_used ?? 0) },
  ];
  return (
    <div className="grid gap-2 rounded-xl border bg-card p-4 sm:grid-cols-2 lg:grid-cols-4">
      {rows.map((r) => (
        <div key={r.label}>
          <p className="text-xs text-muted-foreground">{r.label}</p>
          <p className="truncate text-sm font-medium">{r.value}</p>
        </div>
      ))}
    </div>
  );
}

// Qualification is only known from the scored outcome — the lead having a name
// says nothing about how the call went.
function leadQuality(outcome?: string | null): string {
  const value = (outcome ?? '').toLowerCase();
  if (!value) return 'Not scored';
  return QUALIFIED_OUTCOMES.has(value) ? 'Qualified lead' : 'Not qualified';
}

function AIAnalysis({ call }: { call: Call }) {
  const a: CallOutcome | null | undefined = call.analysis;
  const items: Array<{ label: string; value?: string | null }> = [
    { label: 'Intent', value: call.intent },
    { label: 'Lead quality', value: leadQuality(a?.outcome ?? call.outcome) },
    { label: 'Sentiment', value: call.sentiment },
    { label: 'Outcome', value: a?.outcome ?? call.outcome },
    { label: 'Confidence', value: a?.confidence !== undefined && a?.confidence !== null ? `${Math.round(a.confidence * 100)}%` : undefined },
  ];
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><ThumbsUp className="h-4 w-4" /> AI Analysis</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {items.map((it) => (
          <div key={it.label} className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{it.label}</span>
            <span className="font-medium">{it.value || '—'}</span>
          </div>
        ))}
        {a?.reason ? (
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Reason</p>
            <p className="mt-1">{a.reason}</p>
          </div>
        ) : null}
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Summary</p>
          <p className="mt-1">{call.summary || 'No summary generated.'}</p>
        </div>
        {a?.next_action || call.next_action ? (
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Next action</p>
            <p className="mt-1">{a?.next_action ?? call.next_action}</p>
          </div>
        ) : null}
        <Link to={`/results/leads`} className="block text-primary hover:underline">
          Manage leads →
        </Link>
      </CardContent>
    </Card>
  );
}