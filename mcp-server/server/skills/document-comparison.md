---
name: document-comparison
description: Compare two documents of a project clause by clause: PAD vs. signed financing agreement, PAD targets vs. ICR results, or two versions of a procurement plan.
---

# Document comparison

Use for: "compare the PAD and the signed financing agreement: project description, effectiveness conditions, disbursement conditions, implementing arrangements", "compare what the PAD promised with what the ICR says was achieved", "what changed between these two versions of the procurement plan".

## Steps

1. **Project ID:** if you only have a name, find it with `search_projects`.
2. **Find both documents:** call `search_documents` with `project_id`, the two `document_types` and `sort: "oldest"` (or `"newest"` for the latest versions). Choose by document type and date, never by relevance order. Typical pairs:
   - PAD vs. agreement: "Project Appraisal Document" and "Financing Agreement" (or "Loan Agreement", "Credit Agreement"; a "Project Agreement" holds the implementing entity's obligations). A project can have several agreements (additional financing): match the agreement to the financing the user means, by date.
   - Promised vs. achieved: "Project Appraisal Document" and "Implementation Completion and Results Report" (ICR); add any "Project Paper" in between, because targets may have been revised by restructuring.
   - Two procurement plans: "Procurement Plan", `sort: "newest"`, `limit: 2` (or the two dates the user names).
3. **Read the same topics in both** with `read_document` and the same `question`, e.g. "effectiveness conditions", "disbursement conditions withdrawal", "implementation arrangements", "results framework indicators targets". Then read the `pages` the outline points to:
   - agreements: Article/Schedule headings (Schedule 1 project description, Schedule 2 execution, Section on withdrawal of proceeds, effectiveness conditions in an Article near the end);
   - PADs: the project description section, implementation arrangements, the results framework annex;
   - ICRs: the results section and the annex on results indicators (baseline, original target, revised target, achieved);
   - procurement plans: the package tables (reference number, description, method, estimated amount, dates, status).
4. **Match items** before comparing: indicators by name, procurement packages by reference number or description, clauses by topic. Flag items present in only one document.
5. **Answer** with a table per topic: item, document A (with page), document B (with page), difference. For results, show original target, revised target (and the paper that revised it) and achieved value; flag indicators that were dropped, added or measured differently. Keep currencies as written, and distinguish estimated costs from contract or awarded amounts.

## Document types

Project Appraisal Document; Financing Agreement / Loan Agreement / Credit Agreement / Project Agreement; Implementation Completion and Results Report; Project Paper / Restructuring Paper; Procurement Plan.

## Citation and coverage rules

- Cite both sides of each difference: title, type, date, page ("Cite as" line) and record link.
- A difference you infer (e.g. a condition missing from the agreement) must say which pages you checked; "not found in pages 1–20 and 35–40" is not "absent".
- State coverage: which documents, versions and pages were read. If one of the pair is not public, say so and do not guess its content.
- Pages are verbatim: quote the clause wording where it matters; don't re-read pages to confirm them.
