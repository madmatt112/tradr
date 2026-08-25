# Documentation style

Tradr's procedural and reference documentation follows a **simplified-English**
house standard derived from ASD-STE100, the controlled-language specification used
in aerospace maintenance manuals. The goal is documentation that is unambiguous on
first reading, uniform between authors, and mechanically checkable.

Declared terminology lives in [`TERMS.md`](TERMS.md). Read that first — most style
mistakes are really vocabulary mistakes.

## Why "derived", and not ASD-STE100 itself

Three practical constraints, stated plainly so nobody re-litigates them:

1. **The approved dictionary is not redistributable.** ASD-STE100 cannot be checked
   into an Apache-2.0 repository, so a contributor cannot look up whether a word is
   approved. Rules we can state ourselves; the dictionary we cannot ship.
2. **Its vocabulary has no entry for our domain.** No _commit_, _container_,
   _repository_, _migration_, _webhook_, _brokerage_, _equity curve_, or
   _expectancy_. STE handles this through declared Technical Names and Technical
   Verbs — that declaration is [`TERMS.md`](TERMS.md), and it is the part that
   actually earns its keep here.
3. **Certified STE checkers are enterprise-priced.** There is no credible free one.

So: adopt the rules, declare the vocabulary, enforce what a linter can enforce, and
call the result **STE-derived** rather than claiming compliance we do not verify.

For everything STE is silent on — heading capitalisation, code-block conventions,
UI-element formatting, admonitions, lists — follow the
[Google developer documentation style guide](https://developers.google.com/style).
STE overrides it only on procedural sentence construction.

## Scope — by audience, not by document type

The split is **who reads it**, not which Diátaxis mode it sits in. A security or
architecture page is exposition, but it is read by someone deciding whether to trust
Tradr with their trading history, and it should be the most precise prose we write.

**In scope — anything an operator or contributor reads to do something:**

- Every how-to and reference page
- The runbooks in `docs/runbooks/`
- Security, architecture, and migration explanations
- README setup steps
- Comments in `.env.example` and `docker-compose.yml`
- The **steps** of a tutorial

**Out of scope — trader-facing narrative:**

- Marketing copy
- "Why journaling improves your trading", "Hosted vs self-hosted: what's different"
- The **introduction** of a tutorial, where a human voice earns attention

Do not retrofit. The best existing pages were written before this guide and are
better than a mechanical rewrite would make them. Apply this to new and
substantially-revised content.

## The rules

**1. One instruction per sentence.** This is the rule that changes writing most.

> ✗ Copy the file and edit the three secrets, then restart the stack.
> ✓ Copy the file. Edit the three secrets. Restart the stack.

**2. Keep procedural sentences under 20 words**, descriptive ones under 25. If a
sentence needs a semicolon, it is two sentences.

**3. Use the imperative for instructions.** "Run the migration", not "The migration
should be run" or "You will want to run".

**4. Use the active voice.** Name the actor. "The api runs migrations on startup",
not "migrations are run on startup".

**5. Use the present tense for what the system does.** "The importer maps your
columns", not "will map".

**6. One term per meaning.** Use [`TERMS.md`](TERMS.md). Never vary a term for
elegance — a synonym reads as a different thing.

**7. Say what happens, then what to do about it.** Lead a troubleshooting section
with the symptom the reader is looking at, not the cause they do not know yet.

**8. State the expected result.** A step the reader cannot verify is not a step.
"**Expected result:** the account appears with a balance of $10,000.00."

**9. Prefer a tested artifact to prose.** If a procedure can be a script that CI
runs, make it one and link to it. `docker/quickstart.sh` is the pattern: the README
points at it rather than restating the commands, so there is no second copy to
drift. Likewise, generate a reference from its source rather than transcribing it.

**10. Do not document what you have not run.** Every command in this repository's
documentation should have been executed, ideally by CI.

## Hosted vs self-hosted

Do not fork a page to cover both. Mark the divergent step inline. On the docs site
that is the `<HostedOnly>` / `<SelfHosted>` components; in this repository, a bold
lead-in:

> **Self-hosted only:** feature gating ships off, so plan limits do not apply.

## Checklist before you open the pull request

- [ ] Every term matches [`TERMS.md`](TERMS.md).
- [ ] Every procedural sentence gives one instruction, in the imperative, under 20 words.
- [ ] Every command has been run, not just typed.
- [ ] Steps state their expected result.
- [ ] Nothing here duplicates a page that already exists — it links instead.
- [ ] No _simply_, _just_, _easily_, or _obviously_.
