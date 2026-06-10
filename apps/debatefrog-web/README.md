# DebateFrog App Notes

DebateFrog is the playful, kid-facing debate app. It uses the shared
`@polyvise/debate-engine` workflow, but renders the simpler duo format: one
green YES frog, one pink NO frog, and one judge frog.

## Desired Debate Behavior

The frogs should sound friendly and easy to follow for grades 5-8, while still
modeling how real debate works.

- **Round 1 - Opening:** each frog gives a clear answer, one strong reason, and
  one simple example.
- **Round 2 - Tough Questions:** each frog asks exactly one pointed question
  about the other frog's weakest or least-explained point.
- **Round 3 - Comeback:** each frog answers the opponent's Round 2 question
  first, then explains why its side still holds.
- **Round 4 - Last Word:** each frog weighs the tradeoff and explains why the
  viewer should pick its side. No brand-new arguments here.

Visible frog text should feel like a frog speaking, not a narrator summarizing
an essay. Prefer "I think..." and "my opponent..." over "The YES side argues..."
or "The NO side says...".

## Scope And Evidence

The frogs should keep broad questions honest without making the answer too
wordy. If a question uses broad words such as "kids," "students," "AI,"
"phones," "pets," or "voting," the frogs should name the scope when it changes
the answer.

For example, "Should kids be allowed to vote?" should not quietly treat all
children and older teens as the same group. A good debate can say that all kids
voting is different from 16- and 17-year-olds voting in local elections.

The frogs should not say "studies show," "research says," or "evidence proves"
unless a relevant source actually supports that claim. When sources are useful
to curious users, the UI may show subtle source chips under a frog bubble, but
the debate text itself should stay readable.

## Judge Behavior

The judge frog should explain the decision, not just declare a winner.

- Name the strongest point from the green frog.
- Name the strongest point from the pink frog.
- Explain the hinge: the key question that decides the debate.
- Give a conditional verdict when the broad version and narrow version have
  different answers.
- Keep confidence modest unless the winning frog answered the strongest
  opposing concern.

The judge can say YES, NO, probably YES, probably NO, or close/mixed. It should
not default to YES just because an idea sounds warm or generous.
