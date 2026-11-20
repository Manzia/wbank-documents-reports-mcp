import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import yaml from 'js-yaml';

const text = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const read = (file) => JSON.parse(text(file));
const policy = read('./session-policy.json');
const settings = read('./session-settings.json');

const glob = (pattern) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
const list = (v) => (Array.isArray(v) ? v : [v]);
const matches = (s, action, resource) => list(s.Action).some((a) => glob(a).test(action)) && list(s.Resource).some((r) => glob(r).test(resource));
// IAM evaluation for a session policy: allowed if some Allow matches and no Deny does
const allowed = (action, resource = '*') =>
  policy.Statement.some((s) => s.Effect === 'Allow' && matches(s, action, resource)) &&
  !policy.Statement.some((s) => s.Effect === 'Deny' && matches(s, action, resource));

const HAIKU_PROFILE = 'arn:aws:bedrock:us-east-1:365677123675:inference-profile/us.anthropic.claude-haiku-5-5';
const GLOBAL_PROFILE = 'arn:aws:bedrock:us-east-1:365677123675:inference-profile/global.anthropic.claude-sonnet-5-5';
const FOUNDATION = 'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-opus-5-5';
const GLOBAL_FOUNDATION = 'arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5';

describe('session-policy.json (plan §2.4 layer 1)', () => {
  test('is an allow-list: no Action "*" and no write verbs in any Allow', () => {
    expect(policy.Version).toBe('2012-10-17');
    const allows = policy.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => list(s.Action));
    expect(allows).not.toContain('*');
    expect(allows.filter((a) => /:(\*|Create|Update|Delete|Put|Set|Tag|Untag|Attach|Detach|Execute|Synchronize|Start(?!Query)|Invoke(?!Model))/.test(a))).toEqual([]);
  });

  test.each([
    ['cloudformation:DescribeStacks'], ['cloudformation:GetTemplate'], ['cloudformation:DescribeStackEvents'],
    ['logs:FilterLogEvents'], ['logs:StartQuery'], ['cloudwatch:GetMetricData'], ['lambda:GetFunctionConfiguration'],
    ['bedrock-agentcore:GetGateway'], ['bedrock-agentcore:ListGatewayTargets'], ['route53:ListResourceRecordSets'],
    ['acm:DescribeCertificate'], ['servicequotas:GetServiceQuota'], ['bedrock:ListInferenceProfiles']
  ])('allows the read %s', (action) => {
    expect(allowed(action)).toBe(true);
  });

  test.each([HAIKU_PROFILE, GLOBAL_PROFILE, FOUNDATION, GLOBAL_FOUNDATION])('allows invoking Claude on %s', (arn) => {
    expect(allowed('bedrock:InvokeModel', arn)).toBe(true);
    expect(allowed('bedrock:InvokeModelWithResponseStream', arn)).toBe(true);
  });

  test.each([
    // deploys and infrastructure changes
    'cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DeleteStack', 'cloudformation:CreateChangeSet', 'cloudformation:ExecuteChangeSet',
    'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration', 'lambda:AddPermission', 'lambda:CreateFunctionUrlConfig',
    'lambda:InvokeFunction', 'lambda:InvokeFunctionUrl', 'lambda:GetFunction',
    'bedrock-agentcore:UpdateGateway', 'bedrock-agentcore:SynchronizeGatewayTargets', 'bedrock-agentcore:DeleteGateway', 'bedrock-agentcore:InvokeGateway',
    'bedrock-agentcore:GetResourceApiKey', 'bedrock-agentcore:GetWorkloadAccessToken',
    'cloudfront:UpdateDistribution', 'cloudfront:CreateInvalidation', 'wafv2:UpdateWebACL', 'route53:ChangeResourceRecordSets',
    'acm:DeleteCertificate', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'cloudwatch:PutMetricAlarm', 'sns:Subscribe',
    'iam:CreateRole', 'iam:PassRole', 's3:PutObject', 's3:DeleteObject', 'budgets:ModifyBudget',
    // reads that would reveal the origin secret (CloudFront custom header, WAF rule, sampled requests, the secret itself)
    'cloudfront:GetDistributionConfig', 'cloudfront:ListDistributions', 'wafv2:GetWebACL', 'wafv2:GetSampledRequests',
    'secretsmanager:GetSecretValue', 'secretsmanager:ListSecrets', 'ssm:GetParameter', 'kms:Decrypt', 's3:GetObject',
    // model configuration
    'bedrock:CreateGuardrail', 'bedrock:PutModelInvocationLoggingConfiguration'
  ])('does not allow %s', (action) => {
    expect(allowed(action)).toBe(false);
  });

  test('allows invoking only Anthropic models in this account', () => {
    expect(allowed('bedrock:InvokeModel', 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0')).toBe(false);
    expect(allowed('bedrock:InvokeModel', 'arn:aws:bedrock:us-east-1:111111111111:inference-profile/us.anthropic.claude-haiku-5-5')).toBe(false);
  });
});

describe('session-settings.json (plan §2.4 layers 2-4)', () => {
  test('sandbox settings, strict mode', () => {
    const { sandbox } = settings;
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.excludedCommands).toEqual([]);
    expect(sandbox.enableWeakerNetworkIsolation).toBe(true);
    expect(sandbox.credentials.files).toEqual([
      { path: '~/.aws/credentials', mode: 'deny' },
      { path: '~/.aws/config', mode: 'deny' },
      { path: '~/.config/gh/hosts.yml', mode: 'deny' }
    ]);
    expect(sandbox.network.allowedDomains).toEqual([
      '*.amazonaws.com', 'github.com', '*.github.com', '*.githubusercontent.com', 'registry.npmjs.org',
      'search.worldbank.org', 'documents1.worldbank.org', 'worldbank-mcp.manzia.com'
    ]);
    expect(sandbox.filesystem.allowWrite).toEqual(['~/.aws-sam']);
    // Whole directories, not just the two key files: ~/.aws also holds credentials.bak, SSO and CLI caches
    expect(sandbox.filesystem.denyRead).toEqual(['~/.aws', '~/.ssh', '~/.config/gh', '~/.wbank-mcp-dispatch/sessions']);
    expect(JSON.stringify(sandbox)).not.toContain('.npm"');
  });

  test('permission deny rules cover credentials, the dispatcher state and cloud triggers', () => {
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([
      'Read(~/.aws/**)', 'Edit(~/.aws/**)', 'Read(~/.config/gh/**)', 'Read(~/.ssh/**)',
      'Edit(~/.wbank-mcp-dispatch/**)', 'Read(~/.wbank-mcp-dispatch/sessions/**)', 'RemoteTrigger', 'CronCreate'
    ]));
    expect(settings.permissions.allow).toBeUndefined();
    expect(settings.env).toBeUndefined();
  });

  test('registers the guard hook on Bash and Agent from the dispatcher copy', () => {
    const [entry] = settings.hooks.PreToolUse;
    expect(entry.matcher).toBe('Bash|Agent|Task');
    expect(entry.hooks).toEqual([{ type: 'command', command: 'node "$HOME/.wbank-mcp-dispatch/guard-hook.mjs"' }]);
  });
});

describe('com.manzia.wbank-mcp-dispatch.plist', () => {
  const plist = text('./com.manzia.wbank-mcp-dispatch.plist');
  const value = (key) => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1];

  test('runs the main checkout every 15 minutes and at login', () => {
    expect(plist).toContain('/Users/roy.manzi/WorldBank/API/wbank-documents-reports-mcp/scripts/dispatch/dispatch-local.sh');
    expect(plist).toMatch(/<key>StartInterval<\/key>\s*<integer>900<\/integer>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  test('discards stdout (decisions already go to the log) and keeps stderr for crashes', () => {
    expect(value('StandardOutPath')).toBe('/dev/null');
    expect(value('StandardErrorPath')).toBe('/Users/roy.manzi/Library/Logs/wbank-mcp-dispatch.launchd.log');
  });
});

describe('context/tasks/wbank-mcp-tasks.yaml', () => {
  const tasks = yaml.load(text('../../context/tasks/wbank-mcp-tasks.yaml'));
  const ids = new Set(tasks.tasks.map((t) => t.id));

  test('has the dispatcher settings', () => {
    expect(tasks.paused).toBe(false);
    expect(tasks.local_capacity).toBeGreaterThan(0);
    expect(tasks.stale_hours).toBeGreaterThan(0);
  });

  test('every task is local or human, with a unique MCP-1xx ID, and depends only on earlier tasks', () => {
    const seen = new Set();
    for (const t of tasks.tasks) {
      expect([t.id, /^MCP-\d{3}$/.test(t.id)]).toEqual([t.id, true]);
      expect([t.id, ['local', 'human'].includes(t.runs)]).toEqual([t.id, true]);
      expect([t.id, seen.has(t.id)]).toEqual([t.id, false]);
      for (const d of t.depends ?? []) expect([t.id, d, ids.has(d) && seen.has(d)]).toEqual([t.id, d, true]);
      seen.add(t.id);
    }
  });
});
