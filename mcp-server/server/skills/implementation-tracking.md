---
name: implementation-tracking
description: Track a project's implementation from its disclosed ISRs: the latest ISR, indicators below target, bottlenecks and assigned actions, and what changed across the last two or three ISRs.
---

# Implementation tracking

Use for: "in the latest disclosed ISR, which indicators are below target", "compare the last three ISRs", "what changed between the last two implementation reports", "what bottlenecks does the latest reporting identify and who must act", "what are the PDO indicators and targets and what does the latest report say".

## Steps

1. **Project ID:** if you only have a name, find it with `search_projects`.
2. **List the ISRs in date order:** call `search_documents` with `project_id`, `document_types: ["Implementation Status and Results Report"]`, `sort: "newest"` and `limit` 2 or 3 (or more if asked). **Never use relevance order for "latest".** ISR titles end with "Sequence No : N"; use the sequence number and the document date to order them, and report both.
3. Optionally call `get_project` for the ratings history and the results indicators held in the Projects record. Its ratings can lag the newest disclosed ISR: prefer the ISR itself and say which source each rating comes from.
4. **Read each ISR** with `read_document` (`document_id`). ISRs are short: read them without a question first (outline and first pages), then ask for the remaining `pages`. Results indicator tables (baseline, actual, target, dates) and the risk table are usually in the later pages.
5. **Older ISRs:** read them the same way. For "what changed", compare ISR by ISR:
   - ratings: progress toward the PDO, overall implementation progress, overall risk, and component or sub-ratings;
   - each results indicator: baseline, latest value, target, and whether it is on track or below target;
   - risks: each category's rating;
   - implementation issues and the actions listed, with who must act (government, implementing agency, the Bank) and by when.
6. **Answer** with a table per comparison (item, earlier ISR, later ISR, change), then the explanations the ISRs give. Mark any indicator the ISRs do not report as "not reported".
7. If the ISRs mention a restructuring, see the `restructuring` skill.

## Document types

- Implementation Status and Results Report (ISR): the main source.
- Aide Memoire (mission findings, where disclosed) and Project Paper (restructuring) may add context; label them as such.

## Citation and coverage rules

- Cite each fact with the ISR's title, sequence number, document date, page ("Cite as" line) and record link.
- Say "the latest **disclosed** ISR (sequence N, dated …)": it is not the project's current internal status.
- An indicator "below target" means what the ISR itself shows; don't compute your own judgement without saying so.
- State coverage: which ISRs (sequence numbers and dates) and which pages you read. If fewer ISRs exist than asked for, say so.
- Pages are verbatim: quote them; don't re-read pages to confirm them.
