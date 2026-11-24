---
name: catalog-search
description: Find World Bank documents and reports by topic, country, type, language, date, author, series, report number or project, count results by country or type, and refine "those results" in follow-ups.
---

# Catalog search

Use for: "find reports on digital learning in Uganda since 2020", "the five most recent procurement plans for the Philippines", "I remember 'learning poverty' was in the title", "French-language reports on teacher training for Morocco or Tunisia", "this project's appraisal document, procurement plans and completion report in chronological order", "find this report number and give me its abstract and PDF", "working papers by this author on education finance", "which countries appear most often in the results for school connectivity", "of those results, only English from 2022 onward, next ten".

## Steps

1. **One call to `search_documents`** with the filters the question names:
   - topic: `query` (quote an exact phrase, e.g. `"learning poverty"`; a remembered title phrase works as a quoted query);
   - place: `countries` (plain names; several mean any of them) or `region`;
   - type: `document_types` (see the table below), `collection` for a series (e.g. "Policy Research working paper");
   - `language`, `date_from` / `date_to` (YYYY, YYYY-MM or YYYY-MM-DD), `author`;
   - a known record: `report_number` or `document_id`; a project: `project_id`.
2. **Order:** for "latest", "most recent" or "in chronological order" set `sort` to `"newest"` or `"oldest"`. Relevance order is not date order. `limit` sets how many (default 10, max 50).
3. **Counts:** for "which countries appear most often", set `facet: "country"` (or `"document_type"`, `"language"`, `"year"`) and rank the counts. Label them as **counts of matching document records**; a multi-country record counts toward each of its countries.
4. **Check the echo:** every result shows the query as run and "Interpreted as" lines. If a term was read wrongly, call again with the corrected value.
5. **Follow-ups on "those results":** call again with the **same inputs** plus the change (add `language`, `date_from`, or `offset` for the next page). The server keeps no state, so carry every earlier input forward yourself.
6. **Abstract and PDF:** the result gives the abstract when the record has one, the record link and the PDF link. If the user wants what the document says, or the abstract is missing, use `read_document` with its `document_id` and a `question`.
7. Few or no results: drop the least important filter, try synonyms or the quoted phrase, or widen dates; say what you changed.

## Document types (examples for `document_types`)

| Wording | Document type |
|---|---|
| PAD | Project Appraisal Document |
| ISR | Implementation Status and Results Report |
| ICR | Implementation Completion and Results Report |
| ESCP | Environmental and Social Commitment Plan |
| Financing agreement | Financing Agreement / Loan Agreement |
| Restructuring paper | Project Paper / Restructuring Paper |
| Program document | Program Document |
| Program appraisal document | Program Appraisal Document |
| Procurement plan | Procurement Plan |
| Working paper | Policy Research Working Paper / Working Paper |
| Country strategy | Country Partnership Framework / Systematic Country Diagnostic |

## Citation and coverage rules

- Cite each record with its title, document type, document date (and disclosure date when it differs), report number, document ID, and the record and PDF links.
- State coverage: how many records matched in total and how many you show ("10 of 23 matching records, newest first").
- A catalog answer is about the **records**: don't claim what a document says from its title alone. Read it with `read_document` first.
- Pages from `read_document` are verbatim: quote them with their page citation.
