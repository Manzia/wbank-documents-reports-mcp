# Evaluation set

The 41 expected queries of `context/design/wbank-mcp-query-design.md` as test cases (design §10.1):
Q1 9, Q2 5, Q3 16, Q4 11. The harness that runs them is MCP-121.

```
evaluation/
├── case.schema.json        # the case format
└── cases/
    ├── Q1-01-….json … Q4-11-….json   # one file per query
    └── cases.test.mjs      # counts per group and region, schema validation
```

Run the check with `node --test evaluation/cases/cases.test.mjs` (Node 24, no dependencies).

## Case format

Each case names its `query_id` (group and row in the expected-queries doc), `tier` (design §9:
`search_and_retrieve`, `project_centred_reading`, `cross_project_synthesis`), `region` and the
`query_wording` exactly as in the doc. `placeholders` records each placeholder (explicit, such as
"Pxxxxxx", or implied, such as an unnamed project) and what replaced it. `turns` holds the user messages
the agent sees; queries that refer back ("those results", "these studies", "these two versions") are
2-turn conversations.

`expected_sources` lists the searches (API and parameters), projects and documents (WDS record ID,
report number, type, date, pages) a correct answer uses. `required: false` marks one acceptable source
among alternatives. `reference_answer` gives one answer per turn with page citations, the date the
sources were read (`as_of`) and the review flag. `rubric` holds the four parts of design §10.2 (right
sources, grounded, complete, scoped) as case-specific criteria. `stability: may_change` marks cases
whose correct answer moves when new documents are disclosed (latest ISR, newest procurement plans,
keyword result sets); the judge should then accept the newest correct sources.

Page numbers are PDF pages, i.e. the form-feed pages of the document's text file. Where a text file has
no form feeds (some ISRs, project papers, older PADs and scanned agreements), citations use the
document's own printed page markers ("Page 3 of 16", "-12-") and the source's `note` says so.

## Review

Every reference answer starts as `"review": "pending"`. The reviewer checks it against the cited
documents and sets `"done"`. The PR is merged only when all 41 say `done` (plan §5.4, MCP-120 check 5).
Points flagged for the reviewer are in each case's `notes`.

## Regions

A case counts for the region of the country or project it is mainly about, using the project's
`regionname` in the Projects API (the two Africa regions count as Africa). Cases about no single
country count for none (plan §5, MCP-120, check 6).

| Region | Cases | Count |
|---|---|---|
| Africa | Q1-01, Q2-01 (Uganda); Q2-03, Q3-10 (Tanzania); Q3-15 (Ethiopia) | 5 |
| East Asia & Pacific | Q1-02, Q2-02 (Philippines); Q3-09 (Indonesia) | 3 |
| Europe & Central Asia | Q4-01, 03, 04, 05, 06, 07 (Tajikistan, the P123456 project); Q4-11 (Central Asia) | 7 |
| Latin America & Caribbean | Q1-05, Q2-05 (Nicaragua); Q3-04 (Peru, Ecuador); Q4-10 (Ecuador, Colombia, Peru) | 4 |
| Middle East & North Africa | Q3-01, 02, 03, 07, 08, 11, 12, 13, 14 (Jordan, the Pxxxxxx project); Q1-04 (Morocco, Tunisia) | 10 |
| South Asia | Q3-06 (Bangladesh, Nepal); Q4-02 (India, Bangladesh); Q4-09 (Bangladesh) | 3 |
| None | Q1-03, Q1-06, Q1-07, Q1-08, Q1-09, Q2-04; Q3-05, Q3-16, Q4-08 (multi-region comparator sets) | 9 |

The three queries that say "similar" or "comparable" without naming a place draw on two regions:
Q3-05 (Kenya, Tanzania, Sri Lanka), Q3-16 (Kenya, Ethiopia, Zambia, India) and Q4-08 (Kenya,
Bangladesh). Q3-04 and Q4-02 name their region and stay within it.

## Projects and documents chosen

The plan asks for evaluation projects that together have a PAD, a financing agreement, at least 3 ISRs,
a restructuring paper and an ICR. Jordan P176619 and Tajikistan P170132 between them have all but the
ICR, and P169165 has the full lifecycle.

| Project | Used in | Why |
|---|---|---|
| **P176619** Jordan Water Sector Efficiency Project, active (MENA) | Q3-01, 02, 07, 08, 11-14 | The "Pxxxxxx" project of Q3: PAD (2023), signed loan agreement, two ESCPs, 8 ISRs (10 records; one ISR is filed three times), a restructuring paper (2026), 49 procurement plans. |
| **P170132** Tajikistan Rural Electrification Project, active (ECA) | Q4-01, 03-07 | The "P123456" project of Q4: PAD (2019), financing agreements, two additional-financing project papers (the 2025 one also restructures the project), seven ESCP versions, 13 ISRs, 29 procurement plans. |
| **P169165** Tanzania Productive Social Safety Net II, closed | Q2-03 | Full lifecycle in one project: PAD (2019), financing agreement, 13 ISRs, AF paper (2023), restructuring paper (2025), ICR (2026). PDO indicators were redefined, which the PAD-vs-ICR comparison must flag. |
| **P174677** Nicaragua COVID-19 Education Sector Response, closed | Q1-05, Q2-05 | Compact record: exactly one PAD, three procurement plans (in Spanish) and one ICR; its last two plans differ in statuses, contract amounts and one added package. |
| **P164765** Philippines Teacher Effectiveness and Competencies Enhancement (TEACEP) | Q2-02 | Education procurement plans with a tablets package, cut from 45,000 to 16,600 tablets between versions. |
| **P508323** Indonesia Productive and Sustainable Investment DPL | Q3-09 | Stand-alone DPL with eight prior actions and a policy and results matrix. |
| **P163732** Tanzania Sustainable Rural Water Supply and Sanitation Program (PforR) | Q3-10 | Eight DLIs with a verification protocol table; its program appraisal document is typed "Project Appraisal Document" in WDS. |
| **P117731** Ethiopia Transport Sector Project in Support of RSDP4, closed | Q3-15 | A transport project with exactly two public procurement plans. |
| P161534, P181563, P176374 (Bangladesh agriculture) | Q4-09 | The active agriculture projects in Bangladesh, from the Projects API. |
| P095570 Peru rural transport; P504400 Ecuador Guayas rural roads | Q3-04 | Andean rural roads precedents (an ICR and a PAD). |
| P179039 Karnataka rural water (PforR); P169342 Bangladesh rural WASH | Q4-02 | Active South Asian rural water operations. |
| P131263 Bangladesh RERED II; P149239 Nepal mini-grids | Q3-06 | Electricity access projects with an economic analysis at appraisal and a later ICR or restructuring paper. |
| P144489 Quito Metro; P117947 Colombia urban transit; P145610 Lima Metro Line 2 | Q4-10 | Recently closed Latin American urban transport projects with ICRs. |
| P152394 Kenya THS-UC; P152736 Tanzania PHC for Results; P181564 Sri Lanka PHC; P171648 Bangladesh Cox's Bazar health; P154784, P164336, P127254, P160408 (Kenya, Ethiopia, Zambia, Maharashtra resilience ICRs) | Q3-05, Q3-16, Q4-08 | Comparator sets for the unnamed "similar" and "comparable" queries. The rubrics accept other qualifying projects if the answer is grounded. |
| Search results and documents not tied to one project: Uganda ETRI report 207830 and related EdTech reports; the newest Philippines procurement plans; Morocco TaRL and preschool reports; WPS9284; Al-Samarrai working papers; WPS9288, WPS8665, WPS4836; Jordan CPF FY24, SCD Update 2023 and CCDR 2022; Central Asia tariff and energy reports | Q1-01 to Q1-04, Q1-06 to Q1-09; Q2-01, Q2-04; Q3-03; Q4-11 | Search and document-reading cases with real report numbers and authors. |

A check script (not committed) compared every `kind: document` source with its WDS record (exists,
document date, report number, type, project ID) and every project ID with the Projects API on
2026-11-23: 123 documents and 34 projects, no differences.

## Observations from building the set

Behaviours of the APIs and files that the cases depend on (as of 2026-11-23):

- `strdate` without `enddate` returns only the start year; "since 2020" needs an end date.
- Facets are returned under `documents.facets`, not at the top level.
- `count_exact` values are the catalog's: "Cote d'Ivoire" (no circumflex). `Senegal^Cote d'Ivoire`
  returned only Senegal records while `Cote d'Ivoire^Senegal` returned both.
- `authr=Al-Samarrai` matches unrelated records; the surname alone (`Samarrai`) works.
- `display_title=learning poverty` matches either word; the quoted phrase is needed.
- Region names differ by API. The Projects API returns "Eastern and Southern Africa" or "Western and
  Central Africa" for African projects and "Middle East, North Africa, Afghanistan, and Pakistan" for
  Jordan. On 2026-11-23 it also returned that region for Pakistan (P169071 and other Pakistan projects),
  and `regionname_exact=South Asia&countrycode_exact=PK` returned nothing. No case uses Pakistan or
  Afghanistan, so the region counts do not depend on how they are filed.
- The French stem "enseign-" matches "enseignements" (lessons) as well as "enseignants" (teachers), so
  a French keyword search for teacher training returns many unrelated reports (Q1-04).
- Some text files have no form-feed page breaks, and several (ISRs, project papers, OCR'd agreements)
  drop the letter "t" throughout. STEP procurement plan tables come out column by column, some
  exports have only an actual-amount column, and Spanish STEP exports split words across columns.
- Some tables are images and missing from the text layer (e.g. the RERED II ICR's ex-post IRR table).
- Documents contain errors an answer should not repeat: the Colombia urban transit ICR calls P144489
  (Quito Metro) the Mexico project; the Tajikistan ESCP prints "June 2015" for 2025; the Indonesia
  DPL matrix cites a regulation as "[MOF regulation #28]".
- Datasheets of some PADs and program documents list officials' names, phone numbers and e-mail
  addresses (Karnataka, Indonesia); the cases' notes tell answers not to reproduce them.
- One file filed under P160083 (34106353) contains an Ethiopia project's procurement plan.
- Records can be stale: P099628 is "Active" with a 2018 closing date.
