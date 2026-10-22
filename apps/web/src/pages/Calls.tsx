import { useEffect, useState } from 'react';
import { Phone, PhoneOutgoing, Play, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, currentSession, fmtDate, q } from '../api.js';
import { toast, useApi } from '../hooks.js';
import { Link, navigate } from '../router.js';
import { Empty, PageHeader, StateBadge } from '../components/layout.js';
import { AiCallDialog, DialDialog } from '../components/dialer.jsx';
import { STATUS_LABEL, fmtDuration } from '../dialer.js';

export function Calls() {
  const [scope, setScope] = useState('all');
  const { data, error, loading, reload } = useApi<{ data: any[] }>(`/v1/calls${q({ 'filter[logged]': scope === 'unlogged' ? 'false' : scope === 'logged' ? 'true' : undefined, include: 'prospect,callDisposition,owner', 'page[size]': 100 })}`, [scope]);
  const dialer = useApi<{ data: any }>('/v1/workspace/dialer');
  const [dial, setDial] = useState(false);
  const [aiCall, setAiCall] = useState(false);
  const dp = dialer.data?.data;
  const tw = dp?.twilio;
  const desc = [tw?.status === 'connected' ? `Twilio · caller id ${tw.fromNumbers[0] ?? 'none'}${tw.softphone ? ' · browser calling on' : ''}` : null, dp?.speko?.status === 'connected' ? `Speko AI calls · ${dp.speko.fromNumbers[0] ?? 'no number'}` : null].filter(Boolean).join('  ·  ');
  return (
    <>
      <PageHeader
        title="Calls"
        description={desc || 'Connect Twilio or Speko under Settings → Dialer to place calls from here. Calls made elsewhere can still be logged from a prospect.'}
        actions={
          <div className="flex gap-2">
            {dp?.speko?.status === 'connected' && (
              <Button variant={dp.provider === 'speko' ? 'default' : 'outline'} onClick={() => setAiCall(true)} data-testid="calls-ai-call">
                <Sparkles className="size-4" /> AI call
              </Button>
            )}
            <Button variant={dp?.provider === 'speko' ? 'outline' : 'default'} onClick={() => setDial(true)} disabled={tw?.status !== 'connected'} data-testid="calls-dial">
              <PhoneOutgoing className="size-4" /> New call
            </Button>
          </div>
        }
      />
      <Tabs value={scope} onValueChange={setScope} className="mb-3">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="unlogged">Needs logging</TabsTrigger>
          <TabsTrigger value="logged">Logged</TabsTrigger>
        </TabsList>
      </Tabs>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && !data && <Skeleton className="h-40 w-full" />}
      {data && data.data.length === 0 && <Empty>No calls yet.</Empty>}
      {data && data.data.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Prospect</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Via</TableHead>
                <TableHead className="text-right">Length</TableHead>
                <TableHead>Disposition</TableHead>
                <TableHead>Insights</TableHead>
                <TableHead>Owner</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((c) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/calls/${c.id}`)} data-testid="call-row">
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(c.time)}</TableCell>
                  <TableCell className="font-medium">{c.prospect?.name ?? c.to ?? c.from}</TableCell>
                  <TableCell>
                    <StateBadge state={c.outcome ?? c.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.mode === 'ai' ? 'AI · Speko' : c.provider === 'twilio' ? `Twilio · ${c.mode}` : 'logged'}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtDuration(c.duration)}</TableCell>
                  <TableCell>{c.callDisposition?.name ? <Badge variant="outline">{c.callDisposition.name}</Badge> : c.loggedAt ? '' : <span className="text-xs text-muted-foreground">not logged</span>}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {c.coachingStatus === 'ready' ? (
                      <span className="inline-flex items-center gap-1">
                        <Sparkles className="size-3" /> coached
                      </span>
                    ) : c.transcriptStatus === 'ready' ? (
                      'transcript'
                    ) : c.transcriptStatus && c.transcriptStatus !== 'none' ? (
                      c.transcriptStatus
                    ) : (
                      ''
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.owner?.name ?? ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <DialDialog open={dial} onOpenChange={setDial} target={{}} onLogged={reload} />
      <AiCallDialog open={aiCall} onOpenChange={setAiCall} target={{}} onDone={reload} />
    </>
  );
}

const SCORE_LABELS: Record<string, string> = { opener: 'Opener', discovery: 'Discovery', listening: 'Listening', valueArticulation: 'Value', objectionHandling: 'Objections', nextStepClarity: 'Next step' };

export function CallDetail({ id }: { id: string }) {
  const call = useApi<{ data: any }>(`/v1/calls/${id}?include=prospect,callDisposition,owner`);
  const ins = useApi<{ data: any }>(`/v1/calls/${id}/insights`);
  const [audio, setAudio] = useState<string | null>(null);
  const [dial, setDial] = useState(false);
  const c = call.data?.data;
  const i = ins.data?.data;
  useEffect(() => {
    if (!i || i.coachingStatus === 'ready' || !['queued', 'running'].includes(i.transcriptStatus) && !['queued', 'running'].includes(i.coachingStatus)) return;
    const t = window.setInterval(() => ins.reload(), 4000);
    return () => window.clearInterval(t);
  }, [i?.transcriptStatus, i?.coachingStatus]);
  const play = async () => {
    const s = currentSession();
    const r = await fetch(`/v1/calls/${id}/recording`, { headers: { authorization: `Bearer ${s?.access_token}` } });
    if (!r.ok) return toast('Recording not available', 'error');
    setAudio(URL.createObjectURL(await r.blob()));
  };
  const coach = async () => {
    try {
      await api(`/v1/calls/${id}/actions/coach`, { method: 'POST' });
      toast('Coaching queued', 'info');
      ins.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  if (call.error) return <p className="text-sm text-destructive">{call.error}</p>;
  if (!c) return <Skeleton className="h-48 w-full" />;
  const co = i?.coaching;
  const st = i?.transcript?.stats;
  return (
    <>
      <Link to="/calls" className="text-sm text-muted-foreground hover:underline">
        ← Calls
      </Link>
      <PageHeader
        title={c.prospect?.name ? `Call with ${c.prospect.name}` : `Call to ${c.to ?? ''}`}
        description={`${fmtDate(c.time)} · ${STATUS_LABEL[c.status] ?? c.status} · ${fmtDuration(c.duration)}${c.owner?.name ? ` · ${c.owner.name}` : ''}`}
        actions={
          <div className="flex gap-2">
            {c.prospect?.id && (
              <Button variant="outline" onClick={() => setDial(true)}>
                <Phone className="size-4" /> Call again
              </Button>
            )}
            {(c.recordingUrl || c.transcriptStatus === 'ready') && (
              <Button variant="outline" onClick={coach} data-testid="call-coach">
                <Sparkles className="size-4" /> {co ? 'Re-run coaching' : 'Coach this call'}
              </Button>
            )}
          </div>
        }
      />
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Outcome</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <Row k="Disposition" v={c.callDisposition?.name ?? (c.loggedAt ? '' : 'not logged')} />
            {c.outcome && <Row k="Outcome" v={String(c.outcome).replace(/_/g, ' ')} />}
            {c.provider && <Row k="Via" v={c.mode === 'ai' ? 'Speko AI agent' : `${c.provider} · ${c.mode}`} />}
            {c.costUsd !== null && c.costUsd !== undefined && <Row k="Cost" v={`$${Number(c.costUsd).toFixed(2)}`} />}
            {c.endReason && <Row k="End reason" v={c.endReason} />}
            <Row k="Direction" v={c.direction} />
            <Row k="From" v={c.from} />
            <Row k="To" v={c.to} />
            <Row k="Mode" v={c.mode} />
            {c.summary && <p className="mt-2 rounded-md bg-muted p-2 text-sm" data-testid="call-summary">{c.summary}</p>}
            {c.notes && !c.summary && <p className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-2 text-sm">{c.notes}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recording</CardTitle>
            <CardDescription>{c.recordingUrl ? `${fmtDuration(c.recordingDurationSeconds)} · transcript ${i?.transcriptStatus ?? '…'} · coaching ${i?.coachingStatus ?? '…'}` : 'No recording'}</CardDescription>
          </CardHeader>
          <CardContent>
            {c.recordingUrl && !audio && (
              <Button variant="outline" onClick={play} data-testid="call-play">
                <Play className="size-4" /> Load recording
              </Button>
            )}
            {audio && <audio controls src={audio} className="w-full" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Talk stats</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {!(st && typeof st.talkRatio === 'number') && <p className="text-muted-foreground">Available once the call is transcribed.</p>}
            {st && typeof st.talkRatio === 'number' && (
              <>
                <Row k="Rep talk share" v={`${Math.round(st.talkRatio * 100)}%`} />
                <Row k="Longest rep monologue" v={`${st.longestRepMonologueSeconds}s`} />
                <Row k="Questions asked" v={`${st.repQuestions} (prospect ${st.prospectQuestions})`} />
                <Row k="Pace" v={`${st.repWordsPerMinute} wpm`} />
                <Row k="Interruptions" v={`rep ${st.interruptionsByRep} · prospect ${st.interruptionsByProspect}`} />
                {st.stereo === false && <p className="text-xs text-muted-foreground">Mono recording: speakers could not be separated.</p>}
              </>
            )}
          </CardContent>
        </Card>
      </div>
      {co && (
        <Card className="mt-4" data-testid="coaching-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4" /> Coaching · {co.score?.toFixed(1)} / 5
              {co.needsReview && <Badge variant="outline">low confidence</Badge>}
            </CardTitle>
            <CardDescription>{co.summary}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <div className="grid gap-2">
              {Object.entries(co.scores ?? {}).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 text-sm">
                  <span className="w-24 text-muted-foreground">{SCORE_LABELS[k] ?? k}</span>
                  <div className="flex gap-0.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <span key={n} className={`h-2.5 w-5 rounded-sm ${n <= (v as number) ? 'bg-primary' : 'bg-muted'}`} />
                    ))}
                  </div>
                  <span className="tabular-nums">{v as number}</span>
                </div>
              ))}
              <Badge className="mt-1 w-fit" variant="secondary">
                {String(co.outcome).replace(/_/g, ' ')}
              </Badge>
            </div>
            <div className="grid gap-3 text-sm">
              <div>
                <div className="mb-1 font-medium">Strengths</div>
                <ul className="list-disc pl-5 text-muted-foreground">{co.strengths?.map((s: string) => <li key={s}>{s}</li>)}</ul>
              </div>
              <div>
                <div className="mb-1 font-medium">Improve</div>
                <ul className="list-disc pl-5 text-muted-foreground">{co.improvements?.map((s: string) => <li key={s}>{s}</li>)}</ul>
              </div>
              <p className="rounded-md border p-2">
                <span className="font-medium">Tip: </span>
                {co.coachingTip}
              </p>
            </div>
            <div className="grid gap-3 text-sm">
              {co.objections?.length > 0 && (
                <div>
                  <div className="mb-1 font-medium">Objections</div>
                  <ul className="grid gap-1">
                    {co.objections.map((o: any, k: number) => (
                      <li key={k} className="flex items-start gap-2">
                        <Badge variant={o.handled ? 'secondary' : 'destructive'} className="mt-0.5">
                          {o.handled ? 'handled' : 'open'}
                        </Badge>
                        <span>
                          “{o.objection}” <span className="text-muted-foreground">{o.note}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {co.nextSteps?.length > 0 && (
                <div>
                  <div className="mb-1 font-medium">Next steps</div>
                  <ul className="list-disc pl-5 text-muted-foreground">{co.nextSteps.map((s: string) => <li key={s}>{s}</li>)}</ul>
                </div>
              )}
              {co.highlights?.length > 0 && (
                <div>
                  <div className="mb-1 font-medium">Highlights</div>
                  <ul className="grid gap-1">
                    {co.highlights.map((h: any, k: number) => (
                      <li key={k}>
                        <span className="font-mono text-xs text-muted-foreground">{h.at}</span> {h.speaker}: “{h.quote}” <span className="text-muted-foreground">{h.why}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      {i?.transcript?.segments?.length > 0 && (
        <Card className="mt-4" data-testid="transcript-card">
          <CardHeader>
            <CardTitle className="text-base">Transcript</CardTitle>
            <CardDescription>{i.transcript.provider}</CardDescription>
          </CardHeader>
          <CardContent className="grid max-h-[32rem] gap-2 overflow-y-auto text-sm">
            {i.transcript.segments.map((s: any, k: number) => (
              <div key={k} className={`flex gap-3 ${s.speaker === 'rep' ? '' : 'text-muted-foreground'}`}>
                <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">{fmtDuration(s.start)}</span>
                <span className="w-16 shrink-0 font-medium">{s.speaker === 'rep' ? (c.mode === 'ai' ? 'Agent' : 'Rep') : 'Prospect'}</span>
                <span>{s.text}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <DialDialog open={dial} onOpenChange={setDial} target={c.prospect?.id ? { prospectId: c.prospect.id, name: c.prospect.name, phone: c.to } : null} onLogged={call.reload} />
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">{v ?? '—'}</span>
    </div>
  );
}
