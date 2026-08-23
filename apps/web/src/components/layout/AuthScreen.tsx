import type { ReactNode } from 'react';

// The branded auth shell (visual-redesign task 9): login and its sibling
// screens (register, forgot/reset password, verify email) all render inside
// it — the ▴ wordmark, the mono product line, and one dim amber equity trace
// behind the card. The trace is decorative chrome, not data, and sits under
// the steering doc's single-series equity-trace amber ruling.
//
// TRACE SHAPE — a deliberately one-line swap. The decision between the two
// takes is DEFERRED (design brief, 2026-08-22): the smooth swoop reads as
// brand gesture, the volatile random-walk-with-drift as a measure of real
// life. Swoop ships as the default until the call is made; flip the constant
// to change every auth screen at once. Do not remove either path.
export const AUTH_TRACE: 'swoop' | 'walk' = 'swoop';

const TRACE_PATHS: Record<typeof AUTH_TRACE | 'walk', string> = {
  swoop:
    'M-20 540 C140 520 260 490 360 455 S540 380 640 360 C700 350 740 368 800 372 S900 352 980 310 C1060 268 1120 220 1190 190 S1340 128 1460 100',
  walk: 'M-20 545 L1.3 539.1 L22.7 536.1 L44.0 537.6 L65.3 524.4 L86.7 520.1 L108.0 516.6 L129.3 504.3 L150.7 505.2 L172.0 502.3 L193.3 500.3 L214.7 482.7 L236.0 481.5 L257.3 472.6 L278.7 480.6 L300.0 473.5 L322.5 443.1 L345.0 452.5 L367.5 437.1 L390.0 414.0 L412.5 398.0 L435.0 371.1 L457.5 352.4 L480.0 350.7 L502.9 348.6 L525.7 359.8 L548.6 369.2 L571.4 372.8 L594.3 390.6 L617.1 398.4 L640.0 415.5 L662.9 406.3 L685.7 407.6 L708.6 401.1 L731.4 403.7 L754.3 395.3 L777.1 387.6 L800.0 406.9 L822.7 389.1 L845.5 369.2 L868.2 349.9 L890.9 323.9 L913.6 305.9 L936.4 291.6 L959.1 270.1 L981.8 272.4 L1004.5 247.0 L1027.3 242.8 L1050.0 215.0 L1075.0 236.2 L1100.0 244.3 L1125.0 239.0 L1150.0 252.8 L1172.1 255.4 L1194.3 234.1 L1216.4 233.6 L1238.6 209.2 L1260.7 190.4 L1282.9 191.0 L1305.0 182.6 L1327.1 159.8 L1349.3 144.1 L1371.4 137.9 L1393.6 140.1 L1415.7 124.0 L1437.9 98.2 L1460.0 89.4',
};

export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 1240 620"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d={TRACE_PATHS[AUTH_TRACE]}
          fill="none"
          className="stroke-primary/10"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="relative w-full max-w-sm">
        <div className="mb-4">
          <p className="flex items-baseline gap-2 text-xl font-bold">
            <span aria-hidden="true" className="text-sm text-primary">
              ▴
            </span>
            Tradr
          </p>
          <p className="font-mono text-xs text-muted-foreground">the open-source trading journal</p>
        </div>
        {children}
      </div>
    </div>
  );
}
