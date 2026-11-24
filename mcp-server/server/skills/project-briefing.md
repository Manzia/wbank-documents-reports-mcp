---
name: project-briefing
description: Brief someone on one World Bank project (objective, agencies, financing, dates, latest disclosed progress, risks), or answer a focused question about one of its documents (ESCP, program document, procurement plan).
---

# Project briefing

Use for: "Brief me on P123456", "pull the documents for this project and group them", "what are its objectives, components, implementing agencies, latest progress and main risks", "what does the ESCP require before civil works", "what prior actions are in the program document", "what are the disbursement-linked indicators", "summarize the latest procurement plan".

## Steps

1. **No project ID?** Call `search_projects` with the name or keywords and the country, then confirm the project ID (e.g. P117635) with the user if more than one project fits.
2. **Profile:** call `get_project` with `project_id`. It gives the objective (PDO), borrower, implementing agency, country, status, approval and closing dates, commitments, sectors and themes, ISR and IEG ratings with their dates, results indicators, and counts of public documents by type.
3. **Document list:** call `search_documents` with `project_id` and `group_by_stage: true`. It groups the project's records into Design, Legal, Environmental and social, Implementation, Restructuring and additional financing, and Completion, newest first. Use it to show "the latest in each group".
4. **Pick the documents to read**, by document type and date (never by relevance order):
   - objectives, components, arrangements, risks: the **Project Appraisal Document** (PAD; for a development policy operation, the **Program Document**; for Program-for-Results, the **Program Appraisal Document**);
   - latest progress and issues: the newest **Implementation Status and Results Report** (ISR). Get it with `search_documents` `project_id`, `document_types: ["Implementation Status and Results Report"]`, `sort: "newest"`, `limit: 1`;
   - changes since approval: any **Project Paper** or **Restructuring Paper** (restructuring and additional financing);
   - obligations: the **Financing Agreement** / **Loan Agreement** / **Credit Agreement**; for environmental and social actions, the **Environmental and Social Commitment Plan** (ESCP) and any later revision;
   - fiduciary: the newest **Procurement Plan**.
5. **Read** each with `read_document` (`document_id` from the search results) and a `question` naming what you need, e.g. "project development objective components implementing agency", "key risks rating", "actions before civil works deadline responsible". Read further `pages` from the outline when the matches don't cover it: results frameworks, policy matrices, DLI tables and procurement tables are often in annexes.
6. **Answer** section by section: objective, components, implementing agencies, commitment, key dates, latest disclosed progress (with the ISR's date and sequence number), main risks, open issues. Mark anything not found in public documents as not available.

## Document types (search_documents `document_types`)

| Wording | Document type |
|---|---|
| PAD | Project Appraisal Document |
| ISR | Implementation Status and Results Report |
| ICR | Implementation Completion and Results Report |
| ESCP | Environmental and Social Commitment Plan |
| Financing agreement | Financing Agreement / Loan Agreement / Credit Agreement |
| Restructuring paper | Project Paper / Restructuring Paper |
| Program document | Program Document (development policy operations) |
| Program appraisal document | Program Appraisal Document (Program-for-Results) |
| Procurement plan | Procurement Plan |

## Citation and coverage rules

- Cite every fact: document title, document type, date, page (from `read_document`'s "Cite as" line), and the record link. Facts from `get_project` cite the Projects record and the project ID.
- Implementation status is the **latest disclosed ISR**, not live data: say "as of the ISR dated …".
- Keep the **commitment** (World Bank financing) separate from **total project cost**; never add them up or swap them.
- Keep the document date and the disclosure date apart when they differ.
- State coverage: which documents and pages you read, e.g. "from the PAD (pp. 1–12, 45–52) and the ISR of 2025-05-30". If a document type has no public record, say so.
- Pages are verbatim: quote them; don't re-read pages to confirm them.
