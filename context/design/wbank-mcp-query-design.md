## World Bank Public APIs

## Overview
Two public sources: [Projects & Operations](https://search.worldbank.org/api/v3/projects) for project records and [Documents & Reports](https://search.worldbank.org/api/v3/wds) for published documents. The project ID is the key for bringing a project record and its documents together.


The **World Bank Documents & Reports API** can support three useful kinds of natural-language questions through MCP: **find documents, explore a set of results, and answer questions about what selected documents say**. The first two can use the REST API directly. The third requires the MCP server to retrieve and read the linked reports. [Official API documentation](https://documents.worldbank.org/en/publication/documents-reports/api) · [Working JSON example](https://search.worldbank.org/api/v3/wds?format=json&qterm=wind%20turbine&fl=docdt,count) [documents.worldbank.org](https://documents.worldbank.org/en/publication/documents-reports/api?utm_source=chatgpt.com)


| API | Endpoint and example | What a TTL can retrieve |
|---|---|---|
| **Projects & Operations** | `GET https://search.worldbank.org/api/v3/projects` · [Active projects in Kenya](https://search.worldbank.org/api/v3/projects?format=json&countrycode_exact=KE&status_exact=Active&rows=20&os=0) | Project IDs, names, status, country, sector, approval and closing dates, commitments, borrower, and implementing agency. Searches can use parameters such as `qterm`, `countrycode_exact`, `status_exact`, `id`, `rows`, and `os`. ([search.worldbank.org][1]) |



## Q1. Questions a REST wrapper can answer directly

| What a user could ask | How the MCP server would answer |
|---|---|
| “Find World Bank reports on digital learning in Uganda since 2020.” | Search `qterm=digital learning`, filter with `count_exact=Uganda` and `strdate=2020-01-01`, and return titles, dates, abstracts, and links. |
| “Show me the five most recent procurement plans for Kenya.” | Filter by country and `docty_exact=Procurement Plan`, order by document date descending, and request five records. |
| “I remember ‘learning poverty’ was in the title. Can you find the report?” | Search `display_title` for those words. Return candidate titles, countries, and dates so the user can identify the right one. |
| “Find French-language reports on teacher training for Senegal or Côte d’Ivoire.” | Combine a keyword search with an exact language filter and either country. Resolve country names to the Bank’s catalog values. |
| “I have the project ID. Show me its appraisal document, procurement plans, and completion report in chronological order.” | Filter by `projectid` and the selected document types, then order by document date. Return the available records for each requested type. |
| “Find this report number and give me its abstract and PDF.” | Look up `repnb_exact`. Return the abstract, official record link, and PDF link where available. A user can also look up a document by `id`. |
| “Find working papers by this author on education finance.” | Combine `authr`, a collection or series filter such as `colti_exact`, and a keyword search. |
| “Which countries appear most often in the results for school connectivity?” | Request the country facet with `fct=count_exact` and rank the returned counts. Label these as **matching document records**. A multi-country record can count toward several countries. |
| “Of those results, show only English-language reports from 2022 onward. Give me the next ten.” | Carry forward the original search, add language and date filters, and use `rows` and `os` for pagination. The MCP client or server must preserve the prior search to interpret “those results.” |

These mappings use documented search fields, exact filters, facets, date ranges, and pagination. One implementation detail deserves a test: the Bank’s sorting instructions name the parameter `srt`, while its example uses `sort`. Verify which one actually changes the returned order before exposing “newest” or “oldest,” especially for keyword searches, which default to relevance. [documents.worldbank.org](https://documents.worldbank.org/en/publication/documents-reports/api?utm_source=chatgpt.com)

## Q2. Questions that need the server to read reports

A useful dividing line is the difference between **“Find Kenya’s procurement plans”** and **“Which of those plans include digital learning materials?”** The first is a catalog query. The second may depend on a single line in a procurement table. The API documents `qterm` as a search across core record fields and exposes links to document text and PDFs. A metadata search alone cannot establish what appears in every table or annex. [documents.worldbank.org](https://documents.worldbank.org/en/publication/documents-reports/api?utm_source=chatgpt.com)

| What a user could ask | What the MCP server would need to do |
|---|---|
| “What barriers to classroom technology adoption does the Uganda diagnostic identify? Cite the pages.” | Locate the diagnostic, read the report, and return each barrier with a supporting passage and page reference. |
| “Which Kenyan education procurement plans mention tablets or digital content? Show the package description, procurement method, and estimated cost.” | Find candidate plans, read their procurement tables, and extract matching rows. Preserve the currency and distinguish an estimated cost from an awarded amount. |
| “Compare what the appraisal document promised with what the completion report says the project achieved.” | Match both documents by project ID, extract the original targets and reported results, and flag indicators that were revised or measured differently. |
| “Which of these studies measured student learning outcomes, and which only reported device distribution or teacher training?” | Read the methods and results sections, classify the measures, and cite the evidence for each classification. |
| “What changed between these two versions of the procurement plan?” | Retrieve both versions, match packages by identifier where available, and compare amounts, methods, dates, and status. |

For these queries, **coverage is part of the answer**. “I found three matching packages in the eight plans I could read” tells a policy analyst something materially different from “Kenya had three such packages.” Likewise, when a user asks for page citations, the reader should preserve PDF page locations during extraction.


## Q3. Example TTL queries

For a Task Team Leader, design the MCP experience around **a project ID and a decision at hand**. The most useful questions are often “What did we agree?”, “What has changed?”, “What is at risk?”, and “What happened in comparable operations?” The World Bank’s project cycle covers identification, preparation, appraisal, negotiations, implementation support, and completion. Documents & Reports contains public project documents alongside country strategies, analytical work, and research that can inform those decisions. [worldbank.org](https://www.worldbank.org/content/dam/partners/scci/docs/pdf/2-SCCI-Project-Cycle.pdf?utm_source=chatgpt.com)

| TTL task | Natural-language query | What the MCP server would use |
|---|---|---|
| **Get oriented** | “Pull the publicly available documents for project Pxxxxxx. Group them into design, legal, environmental and social, implementation, and restructuring documents. Show the latest in each group.” | Project ID and document metadata. |
| **Prepare a mission** | “Brief me on Pxxxxxx before my meeting with the ministry. What are its objectives, components, implementing agencies, latest reported progress, and main risks?” | PAD, latest disclosed ISR, and any restructuring paper. |
| **Establish the country case** | “What do the latest country strategy and diagnostics say about water service constraints in Tanzania? Which findings support a new operation?” | Country Partnership Framework, diagnostics, and sector studies. |
| **Find design precedents** | “Find comparable rural roads projects in East Africa. How did they structure maintenance funding and local government responsibilities?” | Search across projects, then read selected PADs and completion reports. |
| **Choose results measures** | “What indicators, baselines, targets, and data sources have similar primary health care projects used?” | Results frameworks in comparable PADs. |
| **Test assumptions** | “How did recent electricity access projects justify their connection targets and costs? Which assumptions proved difficult during implementation?” | PAD economic analysis, ISRs, and completion reports. |
| **Prepare for negotiations** | “For Pxxxxxx, compare the PAD and signed financing agreement. Where do the project description, effectiveness conditions, disbursement conditions, or implementing arrangements differ?” | Both documents, with clause and page references. |
| **Check agreed obligations** | “What actions does the environmental and social commitment plan require before civil works begin, who is responsible, and when are they due?” | The project’s ESCP and any disclosed revisions. |
| **Review a policy operation** | “In this development policy operation, what prior actions and intended results are set out in the program document?” | Program document and its policy matrix. |
| **Review a results program** | “For this Program-for-Results operation, what are the disbursement-linked indicators and how is each one verified?” | Program appraisal document and related agreements. |
| **Assess implementation** | “In the latest disclosed ISR for Pxxxxxx, which results indicators are below target, and what explanations does the report give?” | Latest ISR, including its results tables. |
| **Track change** | “Compare the last three ISRs. Which risks, ratings, results indicators, and implementation issues changed?” | ISRs in sequence, with dates and source references. |
| **Prepare a client discussion** | “What implementation bottlenecks does the latest reporting identify, and which actions are assigned to the government or the Bank?” | Disclosed ISR and other available implementation documents. |
| **Assess restructuring** | “What does the proposed restructuring change about the objectives, components, results framework, financing, and closing date?” | Original PAD and restructuring paper. |
| **Review fiduciary documents** | “What changed between the two publicly available procurement plans for this transport project?” | Both plan versions, including their package tables. |
| **Apply lessons** | “Across completed agricultural resilience projects in similar countries, what recurring implementation problems appear in the ICRs, and how did teams respond?” | A defined set of completion reports, with a citation for each finding. |


## Q4. Other Queries

The query design should follow **work tasks**, so the same tools serve TTLs, consultants, analysts, and specialists across sectors.

| Common task | Example natural language query | Sources |
|---|---|---|
| Prepare a project briefing | “Brief me on P123456: objective, implementing agencies, commitment, closing date, latest public implementation update, and key issues.” | Projects + documents |
| Find comparable operations | “Find active rural water projects in East Africa similar to this proposed operation. Show their design choices and implementing arrangements.” | Projects + documents |
| Prepare for a client discussion | “For P123456, what commitments and milestones appear in the published agreement and latest restructuring paper? What questions should I raise with the ministry?” | Projects + documents |
| Track implementation | “What changed between the last two publicly available implementation reports for P123456?” | Documents |
| Review results | “What are the project’s development objective indicators and targets, and what does the latest public report say about progress?” | Documents |
| Review environmental and social requirements | “What actions and deadlines does the environmental and social commitment plan set for P123456?” | Documents |
| Review fiduciary arrangements | “Find the latest published procurement plan and summarize the main packages and planned timing.” | Documents |
| Research design precedents | “How have comparable health projects structured community delivery, and what problems emerged during implementation?” | Projects + documents |
| Scan a portfolio | “Which active agriculture projects in Kenya are approaching their closing dates? Who implements them?” | Projects |
| Extract completion lessons | “Across recently closed urban transport projects in South Asia, what recurring implementation lessons appear in completion reports?” | Projects + documents |
| Find background evidence | “Find recent World Bank reports on electricity tariff reform in West Africa relevant to preparing a new operation.” | Documents |

The important implementation boundary is **search versus answering**. The Documents & Reports API can filter records by project ID, document type, country, date, and other metadata, and it returns abstracts and links to document files. Questions about obligations, risks, indicator values, or lessons require the server to open and read the linked public document. Searching its metadata alone cannot reliably answer them. [documents.worldbank.org](https://documents.worldbank.org/en/publication/documents-reports/api?utm_source=chatgpt.com)



## What to build into the query design

**Start with project ID, then preserve the conversation’s project context.** A TTL should be able to ask “What does the financing agreement say?” followed by “Did that change in the restructuring?” without repeating the ID. The API supports a `projectid` filter, as well as country, document type, topic, date, and other metadata filters. [documents.worldbank.org](https://documents.worldbank.org/en/publication/documents-reports/api?utm_source=chatgpt.com)

**Treat “latest” and “changed” as explicit operations.** Retrieve all relevant records for the project, identify the document type and version, and compare documents in date or ISR sequence order. Keep *document date* and *disclosure date* distinct. A keyword search defaults to relevance order, so its first hit is not necessarily the latest report. [documents.worldbank.org](https://documents.worldbank.org/en/publication/documents-reports/api?utm_source=chatgpt.com)

**Read the document for substantive answers.** The API searches and returns document records and metadata, including abstracts and document links. Questions about covenants, indicator tables, costs, obligations, or the reasons for a delay need a text or PDF reading step. Answers should give the document title, date, page or section, and a link so the TTL can inspect the underlying wording. [documents.worldbank.org](https://documents.worldbank.org/en/publication/documents-reports/api?utm_source=chatgpt.com)

**Make the source boundary visible.** Frame an implementation answer as “the latest *disclosed ISR reports*…” when that is its evidence. For a request such as “What is the project’s current disbursement balance?”, add a relevant operations or finance data source. The World Bank provides separate Projects and Finances APIs, and project ID is a common key across operational data. Internal mission notes and active negotiation positions would require an authorized internal source. [The World Bank](https://documents.worldbank.org/en/publication/documents-reports/faqs?utm_source=chatgpt.com)

For an initial release, I would prioritize **project briefings, comparable operations, agreement and PAD comparisons, ISR change tracking, restructuring summaries, and ICR lessons**. Those cover recurring decisions across sectors and functions with a small MCP tool set: document search, retrieval of a project’s document list, and reading a selected document. The assistant can compose those tools to answer the more involved questions in the table.

## MVP

For a first MCP version, I would expose four composable tools:

1. `search_projects` — discover projects using supported filters.
2. `get_project` — retrieve a project profile by ID.
3. `search_documents` — find public reports, including those associated with a project ID.
4. `read_document` — read a document linked from its Documents & Reports record and return relevant passages with page or section references where available.

The assistant can combine those tools to produce a project brief, comparison, or evidence summary. Every answer should show the **project IDs, document titles and dates, and links** behind its claims. It should also distinguish a recorded project commitment from project cost, and a published implementation update from the project’s current internal status.