// TwoFactorSection — the two-factor block on the Account settings tab (design
// C8, Req 1.2/1.6/1.7/1.8/1.10). Mounted above DeleteAccountSection.
//
// One section, four states driven by the status query and the management
// mutations in useTwoFactor:
//   - Off            → a neutral "Off" badge and a "Set up two-factor" button;
//   - enrolling      → the QR code on a <canvas>, the base32 secret as a text
//                      key, a code field and "Confirm" (Req 1.2);
//   - codes shown    → the 10 single-use backup codes once, with "Copy codes"
//                      (Req 1.6) — reached from a confirm or a regenerate;
//   - On             → a neutral "On" badge, "Regenerate backup codes" behind a
//                      code (Req 1.7), and "Turn off" behind a password and a
//                      code in a dialog (Req 1.8).
//
// The QR is drawn with `qrcode`, imported dynamically so the renderer is only
// pulled in when an enrolment actually starts. Destructive styling is reserved
// for the turn-off action; every status badge is neutral (Req 1.10).

import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';

import { useTwoFactor } from '../hooks/useTwoFactor';

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-3" data-slot="two-factor-section">
      <h3 className="text-sm font-medium">Two-factor authentication</h3>
      {children}
    </section>
  );
}

export function TwoFactorSection() {
  const { status, enrol, confirm, regenerate, disable } = useTwoFactor();

  const [confirmCode, setConfirmCode] = useState('');
  const [regenCode, setRegenCode] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const otpauthUri = enrol.data?.otpauthUri;

  // Draw the QR once the enrolment URI and the canvas are both present. The
  // renderer is loaded lazily; `cancelled` drops a late resolution if the
  // canvas has gone (e.g. the user confirmed and the codes replaced it).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!otpauthUri || !canvas) return;
    let cancelled = false;
    void import('qrcode').then((mod) => {
      if (!cancelled) void mod.default.toCanvas(canvas, otpauthUri);
    });
    return () => {
      cancelled = true;
    };
  }, [otpauthUri]);

  if (status.isPending) {
    return (
      <Section>
        <Skeleton className="h-9 w-40" />
      </Section>
    );
  }

  if (status.isError) {
    return (
      <Section>
        <p className="text-sm text-destructive">Could not load your two-factor status.</p>
        <Button variant="outline" className="cursor-pointer" onClick={() => void status.refetch()}>
          Try again
        </Button>
      </Section>
    );
  }

  const enabled = status.data.enabled;
  const backupCodes = confirm.data?.backupCodes ?? regenerate.data?.backupCodes ?? null;

  const dismissCodes = () => {
    confirm.reset();
    regenerate.reset();
  };

  const closeDisable = () => {
    setDisableOpen(false);
    setPassword('');
    setDisableCode('');
  };

  const statusBadge = (
    <Badge
      data-testid="two-factor-status"
      variant={enabled ? 'secondary' : 'outline'}
      className={enabled ? undefined : 'text-muted-foreground'}
    >
      {enabled ? 'On' : 'Off'}
    </Badge>
  );

  let body: React.ReactNode;

  if (backupCodes) {
    // The one-time view of the backup codes (Req 1.6).
    body = (
      <div className="space-y-3" data-testid="two-factor-backup-codes">
        <p className="text-sm text-muted-foreground">
          Save these backup codes somewhere safe. Each one works once, and they are shown only now.
        </p>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
          {backupCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => void navigator.clipboard.writeText(backupCodes.join('\n'))}
          >
            Copy codes
          </Button>
          <Button variant="ghost" className="cursor-pointer" onClick={dismissCodes}>
            Done
          </Button>
        </div>
      </div>
    );
  } else if (enabled) {
    // On: regenerate behind a code (Req 1.7) and turn off behind a dialog (Req 1.8).
    body = (
      <div className="space-y-6">
        <div className="space-y-2" data-testid="two-factor-regenerate">
          <p className="text-sm text-muted-foreground">
            Generate a fresh set of backup codes. This voids your current codes.
          </p>
          <Label htmlFor="two-factor-regenerate-code">Authenticator code</Label>
          <Input
            id="two-factor-regenerate-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={regenCode}
            onChange={(e) => setRegenCode(e.target.value)}
          />
          <Button
            variant="outline"
            className="cursor-pointer"
            disabled={regenCode.length === 0 || regenerate.isPending}
            onClick={() =>
              regenerate.mutate({ code: regenCode }, { onSuccess: () => setRegenCode('') })
            }
          >
            Regenerate backup codes
          </Button>
        </div>

        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Turn two-factor off and sign in with your password alone.
          </p>
          <Button variant="outline" className="cursor-pointer" onClick={() => setDisableOpen(true)}>
            Turn off
          </Button>
        </div>

        <Dialog
          open={disableOpen}
          onOpenChange={(open) => {
            if (!open && !disable.isPending) closeDisable();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Turn off two-factor</DialogTitle>
              <DialogDescription>
                Confirm your password and a current authenticator code to turn two-factor off.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="two-factor-disable-password">Password</Label>
              <Input
                id="two-factor-disable-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="two-factor-disable-code">Authenticator code</Label>
              <Input
                id="two-factor-disable-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                className="cursor-pointer"
                onClick={closeDisable}
                disabled={disable.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                className="cursor-pointer"
                disabled={password.length === 0 || disableCode.length === 0 || disable.isPending}
                onClick={() =>
                  disable.mutate(
                    { password, code: disableCode },
                    {
                      onSuccess: () => {
                        closeDisable();
                        enrol.reset();
                        confirm.reset();
                        regenerate.reset();
                      },
                    },
                  )
                }
              >
                Turn off two-factor
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  } else if (enrol.data) {
    // Enrolling: QR + text key + a code to confirm (Req 1.2).
    body = (
      <div className="space-y-3" data-testid="two-factor-enrol">
        <p className="text-sm text-muted-foreground">
          Scan the QR code with your authenticator app, or enter the key by hand, then confirm with
          a code.
        </p>
        <canvas ref={canvasRef} data-testid="two-factor-canvas" className="rounded-md border" />
        <p className="font-mono text-sm break-all">{enrol.data.secret}</p>
        <Label htmlFor="two-factor-enrol-code">Authenticator code</Label>
        <Input
          id="two-factor-enrol-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={confirmCode}
          onChange={(e) => setConfirmCode(e.target.value)}
        />
        <Button
          variant="default"
          className="cursor-pointer"
          disabled={confirmCode.length === 0 || confirm.isPending}
          onClick={() => confirm.mutate({ code: confirmCode })}
        >
          Confirm
        </Button>
      </div>
    );
  } else {
    // Off: the entry point (Req 1.10).
    body = (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Add a second step to sign-in with an authenticator app.
        </p>
        <Button
          variant="outline"
          className="cursor-pointer"
          disabled={enrol.isPending}
          onClick={() => enrol.mutate()}
        >
          Set up two-factor
        </Button>
      </div>
    );
  }

  return (
    <Section>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Status</span>
        {statusBadge}
      </div>
      {body}
    </Section>
  );
}
