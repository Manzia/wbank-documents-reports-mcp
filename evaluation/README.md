# Evaluation set

The 41 expected queries of `context/design/wbank-mcp-query-design.md` as test cases (design §10.1):
Q1 9, Q2 5, Q3 16, Q4 11. The harness that runs them is MCP-121.

```
evaluation/
├── case.schema.json        # the case format
└── cases/
    ├── Q1-01-….json … Q4-11-….json   # one file per query
    └── cases.test.mjs      # count per group + schema validation
```

Run the check with `node --test evaluation/cases/cases.test.mjs` (Node 24, no dependencies).

## Case format

Each case names its `query_id` (group and row in the expected-queries doc), `tier` (design §9:
`search_and_retrieve`, `project_centred_reading`, `cross_project_synthesis`) and the `query_wording`
exactly as in the doc. `placeholders` records each placeholder (explicit, such as "Pxxxxxx", or
implied, such as an unnamed project) and what replaced it. `turns` holds the user messages the agent
sees; queries that refer back ("those results", "these studies", "these two versions") are 2-turn
conversations.

`expected_sources` lists the searches (API and parameters), projects and documents (WDS record ID,
report number, type, date, pages) a correct answer uses. `required: false` marks one acceptable source
among alternatives. `reference_answer` gives one answer per turn with page citations, the date the
sources were read (`as_of`) and the review flag. `rubric` holds the four parts of design §10.2 (right
sources, grounded, complete, scoped) as case-specific criteria. `stability: may_change` marks cases
whose correct answer moves when new documents are disclosed (latest ISR, newest procurement plans,
keyword result sets); the judge should then accept the newest correct sources.

Page numbers are PDF pages, i.e. the form-feed pages of the document's text file. Where a text file has
no form feeds (some ISRs, project papers and scanned agreements), citations use the document's own
printed page markers ("Page 3 of 16", "-12-") and the source's `note` says so.

## Review

Every reference answer starts as `"review": "pending"`. The reviewer checks it against the cited
documents and sets `"done"`. The PR is merged only when all 41 say `done` (plan §5.4, MCP-120 check 5).
Points flagged for the reviewer are in each case's `notes`.

## Projects and documents chosen

The plan asks for evaluation projects that together have a PAD, a financing agreement, at least 3 ISRs,
a restructuring paper and an ICR. Most are East African, so cases connect (the same country, sector or
project from different angles).

| Project | Used in | Why |
|---|---|---|
| **P164920** Tanzania Roads to Inclusion and Socioeconomic Opportunities (RISE), active | Q3-01, 02, 07, 08, 11-14, Q3-04 | Main TTL project: PAD (2021), signed financing and project agreements, 7 ESCP versions (ESF), 10 ISRs, two additional financing papers (the 2026 one with a restructuring: closing extension, results framework revision), a midterm review aide-memoire, 65 procurement plans. Rural roads, so it is also a design precedent. |
| **P166685** Uganda Electricity Access Scale-up Project (EASP), active | Q4-01, 03-07, Q3-06 | The "P123456" project of Q4: PAD (2022), financing agreement with performance-based conditions, ESCP, 10 ISRs, three restructuring papers (2025-2026), UECCC procurement plans. |
| **P169165** Tanzania Productive Social Safety Net II, closed | Q2-03 | Full lifecycle in one project: PAD (2019), financing agreement, 13 ISRs, AF paper (2023), restructuring paper (2025), ICR (2026). PDO indicators were redefined, which the PAD-vs-ICR comparison must flag. |
| **P174059** Kenya GPE COVID-19 Learning Continuity in Basic Education, closed | Q1-05, Q2-02, Q2-05 | Compact record: exactly one PAD, five procurement plans and one ICR; its plans carry digital-content packages and two consecutive versions to compare. |
| **P146797** Kenya GPE Primary Education Development (PRIEDE), closed | Q2-02 | Procurement plans with a school tablets package (estimate vs signed amount). |
| **P117731** Ethiopia Transport Sector Project in Support of RSDP4, closed | Q3-15 | A transport project with exactly two public procurement plans. |
| **P180504** Tanzania Second Inclusive and Resilient Growth DPF | Q3-09 | Development policy operation with seven prior actions and a results matrix. |
| **P163732** Tanzania Sustainable Rural Water Supply and Sanitation Program (PforR) | Q3-10 | Eight DLIs with a verification protocol table; its program appraisal document is typed "Project Appraisal Document" in WDS. |
| P126498 Rwanda Feeder Roads; P152394 Kenya THS-UC; P152736 Tanzania PHC for Results; P165453 Mozambique ProEnergia; P154784, P164336, P127254 (Kenya, Ethiopia, Zambia resilience ICRs); P508698 and P179012 (Tanzania and Kenya rural WASH programs); P110371, P113028, P098151 (South Asia urban transport ICRs); P149286 Uganda nutrition | Q3-04, 05, 06, 16; Q4-02, 08, 10 | Comparator sets for the cross-project cases. The rubrics accept other qualifying projects if the answer is grounded. |
| Documents without a project: Uganda ETRI report 207830 and related EdTech reports; WPS9284; Al-Samarrai working papers; WPS9288, WPS8665, WPS4836; Tanzania CPF FY25-29 and WASH Poverty Diagnostic; West Africa power-sector reports | Q1-01, 03, 04, 06-09; Q2-01, Q2-04; Q3-03; Q4-11 | Search and document-reading cases with real report numbers and authors. |

## Observations from building the set

Behaviours of the APIs and files that the cases depend on (as of 2026-11-22):

- `strdate` without `enddate` returns only the start year; "since 2020" needs an end date.
- Facets are returned under `documents.facets`, not at the top level.
- `count_exact` values are the catalog's: "Cote d'Ivoire" (no circumflex). `Senegal^Cote d'Ivoire`
  returned only Senegal records while `Cote d'Ivoire^Senegal` returned both.
- `authr=Al-Samarrai` matches unrelated records; the surname alone (`Samarrai`) works.
- `display_title=learning poverty` matches either word; the quoted phrase is needed.
- Some text files have no form-feed page breaks, and several (ISRs, project papers, OCR'd agreements)
  drop the letter "t" throughout. STEP procurement plan tables come out column by column.
- One file filed under P160083 (34106353) contains an Ethiopia project's procurement plan.
- Records can be stale: P099628 is "Active" with a 2018 closing date.
