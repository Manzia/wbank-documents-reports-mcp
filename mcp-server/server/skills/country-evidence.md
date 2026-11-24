---
name: country-evidence
description: Gather evidence on a country or topic from country strategies, diagnostics, sector studies and research: what they find, with page citations, e.g. to support a new operation.
---

# Country evidence

Use for: "what do the latest country strategy and diagnostics say about water service constraints in Jordan; which findings support a new operation", "find recent reports on electricity tariff reform in Central Asia relevant to preparing an operation", "what barriers to classroom technology adoption does the Uganda diagnostic identify; cite the pages", "which of these studies measured learning outcomes, and which only reported device distribution or teacher training".

## Steps

1. **Country strategy and diagnostics:** call `search_documents` with `countries`, `document_types: ["Country Partnership Framework", "Systematic Country Diagnostic"]` and `sort: "newest"`. Older strategies may be a "Country Assistance Strategy Document". The newest of each is "the latest".
2. **Sector and analytical work:** call `search_documents` with `countries` (or `region`, or several `countries` for a group such as Central Asia: Kazakhstan, Kyrgyz Republic, Tajikistan, Turkmenistan, Uzbekistan), a `query` with the topic (try a quoted phrase and a synonym, e.g. `"tariff reform"` and "electricity pricing"), and `date_from` for "recent". Useful `document_types`: "Report", "Country Economic Memorandum", "Country Climate and Development Report", "Public Expenditure Review", "Poverty Assessment", "Policy Note", "Policy Research Working Paper", "Working Paper". Leave `document_types` out to see everything, sorted by relevance.
3. **Choose the documents** from titles, dates and abstracts; tell the user which you will read and why.
4. **Read each** with `read_document` and a `question` naming the topic, e.g. "water service constraints non-revenue water tariffs", "barriers to technology adoption in classrooms". Strategies discuss a sector in a few pages: the outline shows where. For "which studies measured X", read each study's methods and results sections and classify it, with the evidence.
5. **Answer** finding by finding, each with its source and page. For "which findings support a new operation", link each finding to the operation's possible design, and say it is your synthesis.

## Document types

Country Partnership Framework; Systematic Country Diagnostic; Country Assistance Strategy Document; Country Economic Memorandum; Country Climate and Development Report; Public Expenditure Review; Poverty Assessment; Policy Note; Report; Policy Research Working Paper; Working Paper.

## Citation and coverage rules

- Cite each finding: title, document type, date, page ("Cite as" line) and record link.
- Give the dates of the strategy and diagnostic you used; say if a newer one may exist but is not public.
- **Coverage is part of the answer:** say which documents and pages you read, and that other reports may hold more.
- Separate what a document states from your own synthesis.
- Pages are verbatim: quote them; don't re-read pages to confirm them.
