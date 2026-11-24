---
name: restructuring
description: Summarize what a project's restructuring or additional financing changed (objectives, components, results framework, financing, closing date), and the commitments and milestones in its agreement and latest restructuring paper.
---

# Restructuring

Use for: "what does the proposed restructuring change about the objectives, components, results framework, financing and closing date", "what commitments and milestones appear in the published agreement and the latest restructuring paper", "did that change in the restructuring".

## Steps

1. **Project ID:** if you only have a name, find it with `search_projects`. Keep the project ID from earlier in the conversation for follow-ups.
2. **Find the restructuring papers:** call `search_documents` with `project_id`, `document_types: ["Project Paper", "Restructuring Paper"]` and `sort: "newest"`. The newest is "the latest restructuring"; list the others with their dates. A project paper can be a restructuring, an additional financing, or both: the title and first pages say which.
3. **Find the baseline:** the original **Project Appraisal Document** (`document_types: ["Project Appraisal Document"]`, `sort: "oldest"`), and the **Financing Agreement** (or "Loan Agreement" / "Credit Agreement") for commitments and milestones.
4. Call `get_project` for the current closing date, commitment and status, to check against the paper.
5. **Read the restructuring paper** with `read_document`: first without a question (outline and the summary pages), then with questions such as "changes to the project development objective", "components", "results framework", "reallocation financing", "closing date extension". Project papers usually have a summary table of changes and a section per change; ask for those `pages`.
6. **Read the matching PAD sections** with the same questions, to show the before and after.
7. **Answer** with a table: area (objectives, components, results framework, financing and reallocation, closing date, implementing arrangements, other), before (PAD or earlier paper, with page), after (restructuring paper, with page), reason given. Mark areas the paper does not change as "no change stated". For "questions to raise with the ministry", base each question on a cited commitment, milestone or change.

## Document types

Project Paper / Restructuring Paper (restructuring and additional financing); Project Appraisal Document; Financing Agreement / Loan Agreement / Credit Agreement; Implementation Status and Results Report (for the status that prompted the change).

## Citation and coverage rules

- Cite each change on both sides: title, type, date, page ("Cite as" line) and record link.
- Say whether a restructuring is **proposed** (paper only) or reflected in the Projects record (`get_project`), and keep the paper's date.
- Keep the commitment (World Bank financing) separate from total project cost.
- State coverage: which papers (with dates) and which pages were read; say if earlier restructurings were not read.
- Pages are verbatim: quote them; don't re-read pages to confirm them.
