import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtDate, q } from '../api.js';
import { useApi } from '../hooks.js';
import { Link } from '../router.js';
import { Empty, PageHeader, StateBadge } from '../components/layout.js';

export function Emails() {
  const [status, setStatus] = useState('all');
  const { data, error, loading } = useApi<{ data: any[] }>(`/v1/emails${q({ 'filter[status]': status === 'all' ? undefined : status, include: 'prospect', 'page[size]': 100 })}`, [status]);
  return (
    <>
      <PageHeader
        title="Emails"
        description="Everything sent and received through connected mailboxes."
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {['draft', 'queued', 'sent', 'received', 'rejected', 'failed'].map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && !data && <Skeleton className="h-40 w-full" />}
      {data && data.data.length === 0 && <Empty>No emails yet.</Empty>}
      {data && data.data.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Prospect</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Engagement</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(e.date ?? e.createdAt)}</TableCell>
                  <TableCell>
                    <StateBadge state={e.status} />
                  </TableCell>
                  <TableCell>{e.prospect?.id ? <Link to={`/prospects/${e.prospect.id}`} className="hover:underline">{e.prospect.name ?? e.to}</Link> : e.from}</TableCell>
                  <TableCell>{e.subject}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.openCount ? `${e.openCount} opens ` : ''}
                    {e.clickCount ? `${e.clickCount} clicks ` : ''}
                    {e.repliedAt ? 'replied ' : ''}
                    {e.bouncedAt ? 'bounced' : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
