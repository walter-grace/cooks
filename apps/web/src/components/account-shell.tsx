import type { ReactNode } from 'react';
import { House } from './house.js';

/**
 * The frame around sign-in, sign-up, reset and invite pages: the Cooks house drawn behind the
 * form, and a plain explanation of what an account and a workspace are. On wide screens the
 * house and the explanation take the left panel; on phones the house sits faded behind the card.
 */

const STEPS: Array<[string, string]> = [
  ['Sign up once', 'You get an account for yourself and a workspace for your team. You are the workspace admin.'],
  ['A workspace is your team’s room', 'Prospects, sequences, calls and settings live in it. Invite teammates from Settings and they join with a link.'],
  ['Sign in any time', 'Use your email and password. One account can belong to more than one workspace.'],
];

function Brand() {
  return (
    <a href="https://cooks-sales.vercel.app" className="inline-flex items-center gap-2 text-sm font-semibold tracking-tight">
      <span className="grid size-7 place-items-center rounded-md bg-foreground text-background">C</span>
      <span>
        C<span className="underline decoration-2 underline-offset-[3px]">oo</span>ks
      </span>
    </a>
  );
}

function Steps({ compact = false }: { compact?: boolean }) {
  return (
    <ol className={compact ? 'grid gap-2 text-xs text-muted-foreground' : 'grid gap-4 text-sm'} data-testid="account-steps">
      {STEPS.map(([title, body], i) => (
        <li key={title} className="flex gap-3">
          <span className={compact ? 'mt-px font-medium tabular-nums text-foreground' : 'grid size-6 shrink-0 place-items-center rounded-full border text-xs font-medium tabular-nums'}>{i + 1}</span>
          <span>
            <span className="font-medium text-foreground">{title}.</span> {body}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AccountShell({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <div className="account-shell grid min-h-screen bg-background lg:grid-cols-[minmax(0,1.15fr)_minmax(420px,0.85fr)]" data-testid={testid}>
      <aside className="relative hidden overflow-hidden border-r lg:block lg:p-10">
        <div className="house-stage" aria-hidden="true">
          <House />
        </div>
        <div className="relative z-10 grid max-w-md gap-6">
          <Brand />
          <div className="rounded-xl border bg-background/85 p-6 shadow-sm backdrop-blur">
            <h2 className="text-2xl font-semibold tracking-tight">Your team&rsquo;s sales floor.</h2>
            <p className="mt-2 text-sm text-muted-foreground">Cooks runs sequences, a parallel dialer, buying signals and call coaching. Everything your team does lives in one workspace.</p>
            <div className="mt-5">
              <Steps />
            </div>
          </div>
        </div>
      </aside>
      <main className="flex items-center justify-center p-4 sm:p-8">
        <div className="grid w-full max-w-sm gap-4">
          <div className="lg:hidden">
            <Brand />
          </div>
          <div className="house-strip lg:hidden" aria-hidden="true">
            <House />
          </div>
          {children}
          <div className="rounded-xl border bg-background p-4 lg:hidden">
            <Steps compact />
          </div>
        </div>
      </main>
    </div>
  );
}
