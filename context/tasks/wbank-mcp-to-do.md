

How to Secure a Public Repo Setup

1. Use OIDC with Strict Conditions. Lock your AWS IAM role trust policy so it only accepts tokens from repo:YOUR_ORG/YOUR_REPO:ref:refs/heads/main.
2. Trigger Only on push to main. Ensure deployment workflows never run on pull_request or pull_request_target events from forks.
3. Use Environments with Required Reviewers. Configure a GitHub Environment (e.g., production) that holds your deployment secrets/variables and requires your manual approval before any workflow job can run.
4. Replace PowerUserAccess with Least Privilege. Give your deployment role only the exact permissions needed for your stack (plus specific iam:* permissions if your CloudFormation templates create IAM roles).

## Design Public MCP server
**Your Task** 
- generate the aws architecture/design for a public MCP server that wraps the World Bank **Documents & Reports API** and **Projects & Operations API**
- save the design doc (.md) in `context/design/`, once I approve, commit and push on feature branch (include all uncommitted docs in context folder).

**References**
- Expected Queries: `context/design/wbank-mcp-query-design.md`

**Rules**
- NO Code in the design doc unless absolutely necessary for clarity.

**Requirements**
1. MCP server is publicly accessible and can easily be added as a Tool to popular AI tools e.g `Claude Cowork/Code`, `ChatGPT`, `Gemini` etc.
2. MCP server is implemented via AWS Bedrock AgentCore Gateway with an AWS Lambda target
- AWS Lambda target can use Claude Haiku 5.5 via AWS Bedrock for query expansion, reformulation etc. as needed. 
3. MCP server supports response streaming by default - see `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-mcp-streaming.html`
4. MCP server has Rate Limiting - see `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-rate-limits.html`
5. MCP server has basic AWS WAF (bot traffic, volumetric traffic) - see `https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-waf.html`
6. MCP server can respond accurately to at least 90% of queries in `Expected Queries` doc on Launch.

**Evaluation**
- Queries in `Expected Queries` doc converted into an evaluation set.
- MCP server (Lambda target) responds accurately to at least 90% of queries in evaluation set.

**Important Constraint**
- Any additions to the 5 requirements above (excluding those required to enable these 5) require my explicit approval.