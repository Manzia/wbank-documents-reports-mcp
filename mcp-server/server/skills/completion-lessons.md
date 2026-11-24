---
name: completion-lessons
description: Extract recurring implementation problems and lessons across a defined set of completed projects from their completion reports (ICRs) and IEG reviews, with a citation per finding.
---

# Completion lessons

Use for: "across completed agricultural resilience projects in similar countries, what recurring implementation problems appear in the ICRs, and how did teams respond", "across recently closed urban transport projects in Latin America, what recurring lessons appear in completion reports", "which assumptions proved difficult during implementation".

## Steps

1. **Define the set of projects:** call `search_projects` with `query` (sector or topic keywords), `countries` or `region`, `status: "Closed"`, and `closing_from` (e.g. the last 10 years for "recently closed"); use `sector` or `theme` if the user names one. Use `sort: "closing_latest"` for "recent". Take about 5–8 projects; tell the user which, and why they fit.
2. **Find each project's completion report:** call `search_documents` with the `project_id` and `document_types: ["Implementation Completion and Results Report"]`. Also look for the IEG review, "Implementation Completion Report Review", and where it exists the "Project Performance Assessment Report". Older projects may have a "Project Completion Report" instead. If a project has no public ICR, drop it and say so.
3. **Read each ICR** with `read_document` and a focused `question`, e.g. "lessons learned", "key factors that affected implementation", "implementation problems delays". ICRs have numbered sections for "Key factors that affected implementation and outcome" and "Lessons and recommendations": ask for those `pages` from the outline. For "how did teams respond", also read the restructuring or implementation sections the ICR points to.
4. **Optional:** call `get_project` for each for the outcome and IEG ratings to put next to the lessons.
5. **Synthesize:** group the findings into recurring themes (e.g. procurement delays, counterpart funding, implementing agency capacity, maintenance funding). For each theme, list the projects where it appears, with a short quote or paraphrase and a citation, and the team's response where the ICR gives one. Note themes found in only one project as such.

## Document types

Implementation Completion and Results Report (ICR); Implementation Completion Report Review (IEG); Project Performance Assessment Report (IEG); Project Completion Report (older projects); Project Paper (restructurings the ICR refers to).

## Citation and coverage rules

- Cite each finding: project ID, ICR title, date, page ("Cite as" line) and record link.
- **Coverage is part of the answer:** "in the 6 ICRs read (P…, P…), 4 report …". Never generalize beyond the set; say which projects had no public ICR.
- Distinguish the ICR's own assessment (by the Bank team) from IEG's review.
- Pages are verbatim: quote them; don't re-read pages to confirm them.
