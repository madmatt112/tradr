import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { FEEDBACK_TEXT_MAX_LENGTH } from '@/lib/telemetry/posthog';
import { cn } from '@/lib/utils';

import { FEEDBACK_ISSUES_URL } from '../geometry';

interface FeedbackFormProps {
  sent: boolean;
  onSend: (rating: number, text: string) => void;
}

const RATINGS = [1, 2, 3, 4, 5] as const;
// The remaining-character counter appears only inside this last stretch.
const COUNTER_THRESHOLD = 200;

/**
 * FeedbackForm — the two-question feedback form (Component 4): a 1–5 rating
 * radiogroup, an optional free-text field, one line of anonymity copy, and a
 * Send button, plus the "Sent. Thank you." swap.
 *
 * Pure presentation. It holds only local input state (rating, text) and a
 * form-local double-activation guard (`sendingRef`); it makes no telemetry
 * call and reads no store. `FEEDBACK_TEXT_MAX_LENGTH` is imported (never
 * redefined). The parent owns the open/sent lifecycle and remounts the form
 * per open (`key={submissionId}`), so the guard resets for free.
 */
export function FeedbackForm({ sent, onSend }: FeedbackFormProps) {
  const [rating, setRating] = useState<number | null>(null);
  const [text, setText] = useState('');
  // Synchronous double-activation guard: checked-and-set in the click handler
  // before onSend fires, so the parent receives at most one onSend per mount.
  const sendingRef = useRef(false);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  if (sent) {
    return <p className="text-sm text-popover-foreground">Sent. Thank you.</p>;
  }

  function selectRating(value: number) {
    setRating(value);
    buttonRefs.current[value - 1]?.focus();
  }

  function moveRating(delta: number) {
    // Roving focus starts on the selected radio, or the first when none is.
    const current = rating ?? 1;
    let next = current + delta;
    if (next > 5) next = 1;
    if (next < 1) next = 5;
    selectRating(next);
  }

  function handleRatingKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveRating(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveRating(-1);
    }
  }

  function handleSend() {
    if (rating === null) return;
    if (sendingRef.current) return;
    sendingRef.current = true;
    onSend(rating, text);
  }

  const remaining = FEEDBACK_TEXT_MAX_LENGTH - text.length;
  // The tabbable radio is the selected one, or the first when none is selected.
  const rovingValue = rating ?? 1;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div role="radiogroup" aria-label="Rating" className="flex gap-2">
          {RATINGS.map((value) => {
            const selected = rating === value;
            return (
              <button
                key={value}
                ref={(el) => {
                  buttonRefs.current[value - 1] = el;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={rovingValue === value ? 0 : -1}
                onClick={() => selectRating(value)}
                onKeyDown={handleRatingKeyDown}
                className={cn(
                  'flex h-10 w-10 cursor-pointer items-center justify-center rounded-md font-mono text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  selected
                    ? 'border-2 border-foreground bg-secondary text-secondary-foreground'
                    : 'border border-input bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {value}
              </button>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-xs text-muted-foreground">
          <span>Rough</span>
          <span>Great</span>
        </div>
      </div>

      <div>
        <Textarea
          aria-label="Details (optional)"
          maxLength={FEEDBACK_TEXT_MAX_LENGTH}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {remaining < COUNTER_THRESHOLD && (
          <p className="mt-1 text-xs text-muted-foreground">{remaining} characters remaining</p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        This is anonymous, so we can&apos;t reply. For something that needs an answer, open a{' '}
        <a
          href={FEEDBACK_ISSUES_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="cursor-pointer underline hover:text-foreground"
        >
          GitHub issue
        </a>
        .
      </p>

      <Button
        type="button"
        className="w-full cursor-pointer"
        disabled={rating === null}
        onClick={handleSend}
      >
        Send
      </Button>
    </div>
  );
}
