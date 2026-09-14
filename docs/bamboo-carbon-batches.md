# Bamboo carbon-credit batches — supersession note

Three `carbon-credit` (VCU) assets have been minted against the Wayanad bamboo
plot (`bamboo-plot` asset `2fe64566-9879-4f7c-a8c4-068cb3982d4e`, 12.5 ha).
Asset metadata is immutable once minted, so this note records what the two
earlier batches are missing rather than editing them in place.

| Asset ID | Name | Supply | Minted | Status |
|---|---|---|---|---|
| `30e8efbf-2866-43d7-888a-0b011e192cf4` | VCU — Bamboo Plot BP-001 Sequestration 2026 | 5,000 VCU | 2026-09-14 09:59 | **Superseded** — see below |
| `c4afac53-565f-464e-9fb8-9098dca8de0d` | VCU — Wayanad Bamboo Agarbatti Feedstock 2026 | 3,000 VCU | 2026-09-14 11:07 | **Superseded** — see below |
| `65dea67f-be1b-4c52-b52f-857315ea8bb9` | VCU — Wayanad Bamboo Bund Plantation ARR 2026 (Track A, Census-Based) | 805 VCU | 2026-09-14 13:35 | **Canonical figure** for this plot |

## What's superseded, and why

Batches 1 and 2 were minted before `carbon-credit.json` gained the
methodology-realism fields (`methodologyTrack`, `quantificationApproach`,
`netTco2ePerHaLifetime`, `bufferPct`, `uncertaintyDeductionPct` — see commit
`3be6f09`). Their `netTco2ePerHaLifetime` is unset, and neither was
quantified against the plantation's real declining sequestration curve. If
anyone infers a lifetime sequestration figure for this plot from batch 1 or
2's volume, that figure is not grounded in the corrected model and should
not be quoted.

Batch 3 is: 12.5 ha × 64.4 net tCO₂e/ha (declining-curve model output, after
a 17.5% non-permanence buffer and 10% uncertainty deduction) = 805 tCO₂e,
Track A (standing-biomass ARR), quantified census-based (bund/intercrop
planting — the plot's own registry entry is the census). **This is the
number to treat as authoritative for this plot's carbon claim.**

## What this note is not

This is a project record, not an on-chain correction. Batches 1 and 2 remain
`active`, fully transferable, and their minted supply (5,000 + 3,000 = 8,000
VCU) is still real, on-ledger, and was never retired or frozen — this note
does not change their tradability. It exists solely so that a reader
comparing the three assets understands why their figures diverge, and which
one reflects the methodology the platform's config now documents.
