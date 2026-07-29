-- Dashboard row unit 80px -> 40px (spec dashboard, Req 1.10 / 1.11).
--
-- Saved layouts are denominated in rows, so at the new unit they would render
-- at half their former height. Doubling `y` and `h` is the only transform that
-- preserves the layout's structure exactly: non-overlap is invariant under a
-- uniform scale of the vertical axis (if y_a + h_a <= y_b then
-- 2*y_a + 2*h_a <= 2*y_b), relative proportions are unchanged, and `x`/`w` are
-- untouched because columns did not change.
--
-- It does NOT preserve absolute pixel height: the per-row pitch goes from 96px
-- to 56px, so a doubled widget ends up ~17% taller. Accepted — erring taller
-- beats silently halving every existing dashboard.
--
-- Old bounds fit the new ones with room to spare (h <= 6 becomes h' <= 12,
-- against a cap of 24), so this cannot produce an out-of-range placement.
UPDATE "dashboard_layouts"
SET "widgets" = (
  SELECT COALESCE(jsonb_agg(
    w || jsonb_build_object(
      'y', (w->>'y')::int * 2,
      'h', (w->>'h')::int * 2
    )
    ORDER BY idx
  ), '[]'::jsonb)
  FROM jsonb_array_elements("widgets") WITH ORDINALITY AS t(w, idx)
),
"updated_at" = now()
WHERE jsonb_array_length("widgets") > 0;
