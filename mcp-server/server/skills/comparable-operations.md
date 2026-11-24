---
name: comparable-operations
description: Find comparable World Bank operations and compare their design choices, implementing arrangements, results indicators or cost assumptions from their PADs (and ICRs for what happened).
---

# Comparable operations

Use for: "find comparable rural roads projects in the Andean countries; how did they structure maintenance funding and local government responsibilities", "active rural water projects in South Asia similar to this operation: design choices and implementing arrangements", "what indicators, baselines, targets and data sources have similar primary health care projects used", "how did electricity access projects justify their connection targets and costs".

## Steps

1. **Build the set:** call `search_projects` with `query` (sector or topic keywords, e.g. "rural roads", "primary health care"), `countries` (spell out groups yourself: "Andean countries" = Bolivia, Colombia, Ecuador, Peru, and Venezuela if wanted) or `region`, and `status` ("Active" for current operations, "Closed" for experience). Add `sector`, `theme` or approval dates if the user names them. Check the "Interpreted as" lines and adjust. Choose about 4–8 projects that truly match; tell the user which and why.
2. **For each project, find its design document:** `search_documents` with `project_id` and `document_types: ["Project Appraisal Document"]` (for policy operations "Program Document"; for Program-for-Results "Program Appraisal Document"). For "what happened during implementation", also the "Implementation Completion and Results Report" and the latest "Implementation Status and Results Report".
3. Optionally call `get_project` for each: implementing agency, commitment, dates, sectors.
4. **Read the relevant part of each PAD** with `read_document` and a `question` naming the design topic, e.g. "maintenance funding road fund local government responsibilities", "implementation arrangements", "results framework indicators baseline target data source", "economic analysis connection cost assumptions". The results framework is usually an annex; ask for its `pages` from the outline.
5. **Compare** in a table: project ID and name, country, status, the design choice or arrangement, indicator / baseline / target / data source where asked, page citation. Then summarize the common patterns and the differences. For "what problems emerged", add the ICR or ISR findings per project.

## Document types

Project Appraisal Document (design, arrangements, results framework, economic analysis); Program Document; Program Appraisal Document; Implementation Completion and Results Report; Implementation Status and Results Report.

## Citation and coverage rules

- Cite each design choice or indicator: project ID, document title, date, page ("Cite as" line) and record link.
- **Coverage is part of the answer:** "in the 5 PADs read …". Say which projects had no public PAD, and that the set is a sample, not every comparable project.
- Keep the commitment (World Bank financing) separate from total project cost.
- Label status correctly: "Active" projects' design is as appraised; changes may be in later project papers.
- Pages are verbatim: quote them; don't re-read pages to confirm them.
