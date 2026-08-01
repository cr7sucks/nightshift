#!/usr/bin/env node
/**
 * nightshift — unattended, verified overnight progress for Claude Code.
 *
 * Single file, zero dependencies. Node 18+.
 *
 * The contract this file enforces:
 *   - The AGENT proposes. The RUNNER verifies. A task is only "done" when the
 *     runner's own verify commands pass — never because the agent said so.
 *   - Every task is checkpointed. A failure resets to the checkpoint, so every
 *     commit on the branch is green.
 *   - Nothing touches the base branch. Nothing is ever pushed.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// tiny output helpers
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const bold = (s) => c('1', s);
const dim = (s) => c('2', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const cyan = (s) => c('36', s);

const ts = () => new Date().toISOString();
const log = (...a) => console.log(...a);
const info = (msg) => log(`${dim(new Date().toTimeString().slice(0, 8))} ${msg}`);
const ok = (msg) => info(`${green('✓')} ${msg}`);
const warn = (msg) => info(`${yellow('!')} ${msg}`);
const err = (msg) => info(`${red('✗')} ${msg}`);
const rule = () => log(dim('─'.repeat(64)));

class Fatal extends Error {}
const fatal = (msg) => {
  throw new Fatal(msg);
};

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  branch_prefix: 'nightshift/',
  plan_file: 'NIGHT_PLAN.md',
  report_file: 'NIGHT_REPORT.md',
  verify: {},
  baseline_must_pass: true,
  verify_timeout_sec: 900,
  agent_timeout_sec: 1800,
  model: 'opus',
  fallback_model: 'sonnet',
  permission_mode: 'acceptEdits',
  caps: {
    wall_clock_hours: 8,
    total_budget_usd: 40,
    per_task_budget_usd: 3,
    max_consecutive_failures: 3,
    min_task_duration_sec: 20,
    max_infra_failures: 2,
    max_plan_limit_waits: 3,
  },
  forbidden_paths: ['.env', '.env.*', 'secrets/', '.github/workflows/', '.git/'],
  disallowed_tools: [
    'Bash(git push:*)',
    'Bash(git remote:*)',
    'Bash(gh:*)',
    'Bash(npm publish:*)',
    'Bash(rm -rf:*)',
    'Bash(sudo:*)',
    'Bash(curl:*)',
    'Bash(shutdown:*)',
    'WebFetch',
  ],
};

function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object' || Array.isArray(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

function loadConfig(root, explicitPath) {
  const p = explicitPath || path.join(root, 'nightshift.config.json');
  if (!fs.existsSync(p)) {
    if (explicitPath) fatal(`Config not found: ${p}`);
    return { ...DEFAULT_CONFIG, _path: null };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fatal(`Config at ${p} is not valid JSON: ${e.message}`);
  }
  return { ...deepMerge(DEFAULT_CONFIG, raw), _path: p };
}

function validateConfig(cfg) {
  const problems = [];
  const caps = cfg.caps;
  if (!(caps.wall_clock_hours > 0)) problems.push('caps.wall_clock_hours must be > 0');
  if (!(caps.total_budget_usd > 0)) problems.push('caps.total_budget_usd must be > 0');
  if (!(caps.per_task_budget_usd > 0)) problems.push('caps.per_task_budget_usd must be > 0');
  if (!(caps.max_consecutive_failures >= 1)) problems.push('caps.max_consecutive_failures must be >= 1');
  if (caps.per_task_budget_usd > caps.total_budget_usd)
    problems.push('caps.per_task_budget_usd exceeds caps.total_budget_usd');
  if (typeof cfg.verify !== 'object' || Array.isArray(cfg.verify))
    problems.push('verify must be an object of {name: command}');
  if (Object.keys(cfg.verify).length === 0)
    problems.push('verify is empty — with no verify commands the runner cannot check the agent\'s work');
  return problems;
}

// ---------------------------------------------------------------------------
// NIGHT_PLAN.md — parse & serialize
//
// Format (one task per `##` heading):
//
//   ## T001 — Short title
//   - status: pending
//   - depends_on: T000
//   - verify: npm test -- orders
//   - files_likely: src/a.ts, src/a.test.ts
//
//   **Acceptance**
//   - criterion one
//   - criterion two
//
//   **Notes**
//   free text
//
// `status` and any `result:`/`commit:`/`blocked_reason:` fields are owned by the
// runner. The agent must never write this file.
// ---------------------------------------------------------------------------

const RUNNER_OWNED_FIELDS = ['status', 'commit', 'blocked_reason', 'cost_usd', 'attempts'];
const VALID_STATUS = new Set(['pending', 'done', 'blocked', 'skipped']);

function parsePlan(text) {
  const lines = text.split('\n');
  const tasks = [];
  let preamble = [];
  let cur = null;

  const flush = () => {
    if (cur) {
      cur.notes = cur.notes.join('\n').trim();
      tasks.push(cur);
    }
    cur = null;
  };

  let section = null; // 'fields' | 'acceptance' | 'notes'

  for (const line of lines) {
    const heading = line.match(/^##\s+(\S+)\s*[—–-]\s*(.+?)\s*$/);
    if (heading) {
      flush();
      cur = {
        id: heading[1].trim(),
        title: heading[2].trim(),
        fields: {},
        acceptance: [],
        notes: [],
        raw: {},
      };
      section = 'fields';
      continue;
    }
    if (!cur) {
      preamble.push(line);
      continue;
    }

    const marker = line.match(/^\*\*(Acceptance|Notes)\*\*\s*$/i);
    if (marker) {
      section = marker[1].toLowerCase();
      continue;
    }

    if (section === 'fields') {
      const f = line.match(/^\s*-\s*([a-z_]+)\s*:\s*(.*)$/i);
      if (f) {
        cur.fields[f[1].toLowerCase()] = f[2].trim();
        continue;
      }
      if (line.trim() === '') continue;
      // Non-field content before a marker falls through to notes.
      section = 'notes';
      cur.notes.push(line);
      continue;
    }

    if (section === 'acceptance') {
      const b = line.match(/^\s*-\s+(.*)$/);
      if (b) {
        cur.acceptance.push(b[1].trim());
        continue;
      }
      if (line.trim() === '') continue;
      section = 'notes';
      cur.notes.push(line);
      continue;
    }

    cur.notes.push(line);
  }
  flush();

  for (const t of tasks) {
    t.status = (t.fields.status || 'pending').toLowerCase();
    if (!VALID_STATUS.has(t.status)) t.status = 'pending';
    t.depends_on = (t.fields.depends_on || '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s && s !== '—' && s !== '-' && s !== 'none');
    t.verify = t.fields.verify && t.fields.verify !== '—' ? t.fields.verify : null;
    t.files_likely = t.fields.files_likely || '';
    t.dryrun = (t.fields.dryrun || 'ok').toLowerCase();
  }

  return { preamble: preamble.join('\n').replace(/\s+$/, ''), tasks };
}

function serializePlan(plan) {
  const parts = [];
  if (plan.preamble.trim()) parts.push(plan.preamble.trim(), '');
  for (const t of plan.tasks) {
    parts.push(`## ${t.id} — ${t.title}`, '');
    const fields = { ...t.fields };
    fields.status = t.status;
    if (t.commit) fields.commit = t.commit;
    else delete fields.commit;
    if (t.blocked_reason) fields.blocked_reason = t.blocked_reason;
    else delete fields.blocked_reason;
    if (t.cost_usd != null) fields.cost_usd = t.cost_usd.toFixed(4);
    if (t.attempts != null) fields.attempts = String(t.attempts);

    // Stable order: status first, then authored fields, then runner extras.
    const order = ['status', 'depends_on', 'verify', 'files_likely', 'dryrun', ...RUNNER_OWNED_FIELDS];
    const seen = new Set();
    for (const k of order) {
      if (fields[k] !== undefined && !seen.has(k)) {
        parts.push(`- ${k}: ${fields[k]}`);
        seen.add(k);
      }
    }
    for (const [k, v] of Object.entries(fields)) {
      if (!seen.has(k)) parts.push(`- ${k}: ${v}`);
    }

    if (t.acceptance.length) {
      parts.push('', '**Acceptance**');
      for (const a of t.acceptance) parts.push(`- ${a}`);
    }
    if (t.notes && t.notes.trim()) {
      parts.push('', '**Notes**', t.notes.trim());
    }
    parts.push('');
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function validatePlan(plan) {
  const problems = [];
  const ids = new Set();
  for (const t of plan.tasks) {
    if (ids.has(t.id)) problems.push(`duplicate task id: ${t.id}`);
    ids.add(t.id);
    if (!t.acceptance.length)
      problems.push(`${t.id}: no acceptance criteria — the agent has no definition of done`);
  }
  for (const t of plan.tasks) {
    for (const d of t.depends_on) {
      if (!ids.has(d)) problems.push(`${t.id}: depends_on unknown task "${d}"`);
    }
  }
  if (!plan.tasks.length)
    problems.push('contains no tasks — run Claude Code here and use /night-plan to build tonight\'s queue');
  return problems;
}

// ---------------------------------------------------------------------------
// shell / git
// ---------------------------------------------------------------------------

function sh(cmd, { cwd, timeoutSec = 600, env } = {}) {
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: env || process.env,
  });
  return {
    code: r.status == null ? 124 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    timedOut: r.status == null,
  };
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function gitOrDie(args, cwd) {
  const r = git(args, cwd);
  if (r.code !== 0) fatal(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function repoRoot(start) {
  const r = git(['rev-parse', '--show-toplevel'], start);
  if (r.code !== 0) return null;
  return r.stdout;
}

function headSha(cwd) {
  return gitOrDie(['rev-parse', 'HEAD'], cwd);
}

function isTreeClean(cwd) {
  return git(['status', '--porcelain'], cwd).stdout === '';
}

function changedPaths(cwd) {
  const out = git(['status', '--porcelain'], cwd).stdout;
  if (!out) return [];
  return out
    .split('\n')
    .map((l) => l.slice(3).trim())
    .map((l) => (l.includes(' -> ') ? l.split(' -> ')[1] : l))
    .filter(Boolean);
}

function resetTo(sha, cwd) {
  git(['reset', '--hard', sha], cwd);
  // -fd removes untracked dirs/files but NOT gitignored ones, so .nightshift/ logs survive.
  git(['clean', '-fd'], cwd);
}

function diffStat(fromSha, toSha, cwd) {
  // git indents every line by one space; strip it so it sits flush in a code fence.
  return git(['diff', '--stat', `${fromSha}..${toSha}`], cwd)
    .stdout.split('\n')
    .map((l) => l.replace(/^ /, ''))
    .join('\n');
}

/**
 * Snapshot the forbidden paths that actually exist on disk.
 *
 * `git status` cannot see changes to gitignored files, and `.env` is gitignored in
 * almost every real project — so the status-based check alone would miss the exact
 * case it most needs to catch. Comparing size+mtime closes that hole.
 */
function snapshotForbidden(root, patterns) {
  const snap = {};
  for (const pat of patterns) {
    if (pat.includes('*')) continue; // globs are covered by the git-status check
    const p = path.join(root, pat.replace(/\/$/, ''));
    try {
      const s = fs.statSync(p);
      snap[pat] = `${s.size}:${s.mtimeMs}:${s.isDirectory() ? 'd' : 'f'}`;
    } catch {
      snap[pat] = null; // absent — reappearing counts as a change
    }
  }
  return snap;
}

function forbiddenTouched(root, patterns, before) {
  const after = snapshotForbidden(root, patterns);
  for (const pat of Object.keys(before)) {
    if (pat === '.git/') continue; // git metadata changes on every legitimate operation
    if (before[pat] !== after[pat]) return pat;
  }
  return null;
}

// glob-ish matcher for forbidden_paths
function matchesForbidden(p, patterns) {
  const norm = p.replace(/^\.\//, '');
  for (const pat of patterns) {
    if (pat.endsWith('/')) {
      if (norm === pat.slice(0, -1) || norm.startsWith(pat)) return pat;
      continue;
    }
    const rx = new RegExp(
      '^' + pat.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
    );
    if (rx.test(norm)) return pat;
    if (norm.startsWith(pat + '/')) return pat;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the agent call
// ---------------------------------------------------------------------------

const TASK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    verification_claim: { type: 'string' },
    blocker_question: { type: 'string' },
  },
  required: ['status', 'summary'],
};

const BUILTIN_NIGHT_RULES = `You are running unattended overnight as part of a nightshift run.

Non-negotiable rules:
1. Do exactly ONE task — the one in the prompt. Do not start adjacent work, do not
   refactor things you merely dislike, do not "while I'm here" anything.
2. Never run: git commit, git push, git reset, git checkout, git branch, git merge.
   The runner owns all git state. Just leave your changes in the working tree.
3. Never edit NIGHT_PLAN.md, NIGHT_REPORT.md, nightshift.config.json, or anything
   under .nightshift/.
4. Match the surrounding code. Read neighbouring files before writing.
5. Run the task's own verify command yourself before declaring done. The runner will
   re-run it independently and it is the runner's result that counts, so there is no
   value in overstating progress.
6. If you are blocked on a decision only a human can make, STOP and return
   status "blocked" with a specific blocker_question. A precise question is a good
   outcome. A confident guess on an ambiguous requirement is the worst outcome.
7. If you finish the acceptance criteria but something adjacent is now broken, say so
   in the summary rather than papering over it.

Return your verdict in the required JSON structure.`;

function nightRules(root) {
  const skill = path.join(root, '.claude', 'skills', 'night-task', 'SKILL.md');
  if (fs.existsSync(skill)) {
    const body = fs.readFileSync(skill, 'utf8').replace(/^---[\s\S]*?---\n/, '').trim();
    if (body) return body;
  }
  return BUILTIN_NIGHT_RULES;
}

function buildTaskPrompt(task, cfg) {
  const lines = [
    `# Task ${task.id}: ${task.title}`,
    '',
    'Acceptance criteria — all must hold when you are done:',
    ...task.acceptance.map((a) => `- ${a}`),
  ];
  if (task.files_likely) lines.push('', `Files likely involved: ${task.files_likely}`);
  if (task.verify) lines.push('', `Task verify command: \`${task.verify}\``);
  const gates = Object.entries(cfg.verify).map(([n, cmd]) => `- ${n}: \`${cmd}\``);
  if (gates.length) {
    lines.push(
      '',
      'After your change, the runner will independently run these gates. They must all pass:',
      ...gates
    );
  }
  if (task.notes) lines.push('', 'Notes from the human who planned this:', task.notes);
  lines.push('', 'Implement the task now.');
  return lines.join('\n');
}

function extractVerdict(resultText) {
  if (!resultText) return null;
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(resultText.trim());
  if (direct) return direct;
  const fence = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    const v = tryParse(fence[1].trim());
    if (v) return v;
  }
  const first = resultText.indexOf('{');
  const last = resultText.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const v = tryParse(resultText.slice(first, last + 1));
    if (v) return v;
  }
  return null;
}

function callAgent(task, cfg, root, opts) {
  const started = Date.now();

  if (opts.dryRun) {
    return dryRunAgent(task, root, started);
  }

  const args = [
    '-p',
    buildTaskPrompt(task, cfg),
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(TASK_RESULT_SCHEMA),
    '--permission-mode',
    cfg.permission_mode,
    '--max-budget-usd',
    String(cfg.caps.per_task_budget_usd),
    '--model',
    cfg.model,
    '--append-system-prompt',
    nightRules(root),
  ];
  if (cfg.fallback_model) args.push('--fallback-model', cfg.fallback_model);
  if (cfg.disallowed_tools?.length) args.push('--disallowedTools', ...cfg.disallowed_tools);

  const r = spawnSync('claude', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: cfg.agent_timeout_sec * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });

  const durationMs = Date.now() - started;

  if (r.error && r.error.code === 'ENOENT') {
    return { infra: true, envelope: null, verdict: null, durationMs, error: '`claude` CLI not found on PATH' };
  }
  if (r.status == null) {
    return {
      infra: false,
      envelope: null,
      verdict: null,
      durationMs,
      error: `agent timed out after ${cfg.agent_timeout_sec}s`,
    };
  }

  let envelope = null;
  const raw = (r.stdout || '').trim();
  try {
    envelope = JSON.parse(raw);
  } catch {
    const line = raw.split('\n').reverse().find((l) => l.trim().startsWith('{'));
    if (line) {
      try {
        envelope = JSON.parse(line);
      } catch {}
    }
  }

  if (!envelope) {
    return {
      infra: true,
      envelope: null,
      verdict: null,
      durationMs,
      error: `could not parse agent output: ${(r.stderr || raw).slice(0, 400)}`,
    };
  }

  const verdict = envelope.is_error ? null : extractVerdict(envelope.result);
  const limit = envelope.is_error ? detectPlanLimit(envelope) : null;
  return {
    infra: false,
    envelope,
    verdict,
    durationMs,
    planLimit: limit,
    error: envelope.is_error ? String(envelope.result || 'agent reported an error') : null,
  };
}

/**
 * A subscription plan limit is not a failure — it's a "come back later". It arrives
 * fast, which would otherwise trip the below-the-floor infrastructure heuristic and
 * kill the night, when the right move is to wait for the rolling window to reset.
 *
 * The upstream error shape isn't contractual, so match defensively on several
 * signals rather than one exact string.
 */
function detectPlanLimit(env) {
  const text = `${env.result || ''} ${env.subtype || ''}`.toLowerCase();
  const is429 = String(env.api_error_status || '') === '429';
  const looksLikeLimit =
    is429 || /usage limit|rate limit|rate_limit|quota|too many requests|limit reached/.test(text);
  if (!looksLikeLimit) return null;

  // Callers often state when the window reopens; prefer that over a blind wait.
  let resetAt = null;
  const epoch = text.match(/\b(1[7-9]\d{8})\b/); // plausible unix seconds
  const iso = (env.result || '').match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/);
  if (epoch) resetAt = Number(epoch[1]) * 1000;
  else if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t)) resetAt = t;
  }
  return { resetAt, detail: String(env.result || env.subtype || 'plan limit reached').slice(0, 200) };
}

/** Block the (deliberately synchronous) runner without burning CPU. */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Dry-run stub. Produces a real working-tree change so the commit/reset paths are
 * genuinely exercised. Behaviour is steered per task by the `dryrun:` field so a
 * test plan can deterministically hit every branch of the loop.
 */
function dryRunAgent(task, root, started) {
  const mode = task.dryrun || 'ok';
  const scratch = path.join(root, 'nightshift-dryrun');

  if (mode === 'agent_error') {
    return {
      infra: false,
      envelope: { is_error: true, result: 'simulated agent error', total_cost_usd: 0.01, num_turns: 1 },
      verdict: null,
      durationMs: Date.now() - started,
      error: 'simulated agent error',
    };
  }
  if (mode === 'infra') {
    return { infra: true, envelope: null, verdict: null, durationMs: 5, error: 'simulated infra failure' };
  }
  if (mode === 'plan_limit') {
    // Route through the real detector so the dry-run exercises the parsing too,
    // not just the wait. Reset 3s out keeps the rehearsal fast.
    const env = {
      is_error: true,
      api_error_status: '429',
      result: `Usage limit reached. Try again at ${new Date(Date.now() + 3000).toISOString()}`,
      total_cost_usd: 0,
      num_turns: 0,
    };
    return {
      infra: false,
      envelope: env,
      verdict: null,
      durationMs: Date.now() - started,
      planLimit: detectPlanLimit(env),
      error: String(env.result),
    };
  }
  if (mode === 'blocked') {
    return {
      infra: false,
      envelope: { is_error: false, result: '', total_cost_usd: 0.02, num_turns: 3 },
      verdict: {
        status: 'blocked',
        summary: 'simulated block',
        blocker_question: 'Which database should this write to?',
      },
      durationMs: Date.now() - started,
      error: null,
    };
  }
  if (mode === 'forbidden') {
    fs.writeFileSync(path.join(root, '.env'), 'SIMULATED=1\n');
  } else {
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, `${task.id}.txt`), `dry-run artifact for ${task.id}\n`);
  }

  return {
    infra: false,
    envelope: { is_error: false, result: '', total_cost_usd: 0.05, num_turns: 4 },
    verdict: {
      status: 'done',
      summary: `simulated work for ${task.id}`,
      files_changed: [`nightshift-dryrun/${task.id}.txt`],
      verification_claim: 'simulated',
    },
    durationMs: Date.now() - started,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// verification — the runner's own gate
// ---------------------------------------------------------------------------

function runVerify(cfg, task, root, { dryRun } = {}) {
  const checks = [];
  if (task?.verify) checks.push(['task', task.verify]);
  for (const [name, cmd] of Object.entries(cfg.verify)) checks.push([name, cmd]);

  const results = [];
  for (const [name, cmd] of checks) {
    if (dryRun && task?.dryrun === 'fail_verify' && name === 'task') {
      results.push({ name, cmd, code: 1, passed: false, output: 'simulated verify failure' });
      break;
    }
    const r = sh(cmd, { cwd: root, timeoutSec: cfg.verify_timeout_sec });
    const passed = r.code === 0;
    results.push({
      name,
      cmd,
      code: r.code,
      passed,
      timedOut: r.timedOut,
      output: (r.stdout + '\n' + r.stderr).trim().slice(-4000),
    });
    if (!passed) break; // fail fast — first red gate is the story
  }
  return { passed: results.every((r) => r.passed), results };
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

function authSmokeTest(cfg) {
  const r = spawnSync(
    'claude',
    // The budget here is a runaway guard, not a target. A trivial prompt still pays for
    // system-prompt cache creation (~$0.17 observed), so a tight cap fails a healthy setup.
    ['-p', 'Reply with exactly: nightshift-ok', '--output-format', 'json', '--tools', '', '--max-budget-usd', '0.50'],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 }
  );
  if (r.error && r.error.code === 'ENOENT') return { ok: false, reason: '`claude` CLI not found on PATH' };
  if (r.status == null) return { ok: false, reason: 'auth smoke test timed out' };
  let env = null;
  try {
    env = JSON.parse((r.stdout || '').trim());
  } catch {
    return { ok: false, reason: `unparseable output: ${(r.stderr || r.stdout || '').slice(0, 200)}` };
  }
  // Spending money proves reachability — a budget stop is a pass, not an auth failure.
  if (env.subtype === 'error_max_budget_usd') return { ok: true, cost: env.total_cost_usd || 0 };
  if (env.is_error) {
    const why = env.result || env.subtype || env.api_error_status || 'agent returned an error';
    return { ok: false, reason: String(why) };
  }
  return { ok: true, cost: env.total_cost_usd || 0 };
}

/**
 * Which wallet a night run draws from. This changes what the caps below mean, so
 * preflight says it out loud rather than letting a subscription user read
 * "$40 budget" as a bill they're about to receive.
 */
function authMode() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return { kind: 'api', label: 'API key — billed per token, so the caps below are real money' };
  }
  return {
    kind: 'subscription',
    label: 'Claude subscription — draws on your plan, not a card; $ figures below are estimates',
  };
}

function preflight(root, cfg, plan, opts) {
  const problems = [];
  const notes = [];

  const cfgProblems = validateConfig(cfg);
  problems.push(...cfgProblems.map((p) => `config: ${p}`));

  const planProblems = validatePlan(plan);
  problems.push(...planProblems.map((p) => `plan: ${p}`));

  if (!isTreeClean(root)) {
    problems.push(
      'working tree is dirty — commit or stash first, otherwise your changes get swept into the agent\'s commits'
    );
  } else {
    notes.push('working tree clean');
  }

  const pending = plan.tasks.filter((t) => t.status === 'pending');
  if (plan.tasks.length && !pending.length)
    problems.push('plan: no pending tasks (everything is already done/blocked/skipped)');

  const mode = authMode();
  if (!opts.dryRun) {
    const auth = authSmokeTest(cfg);
    if (!auth.ok) problems.push(`agent unreachable: ${auth.reason}`);
    else notes.push(`agent reachable — ${mode.label}`);
  } else {
    notes.push(`dry-run: skipping auth smoke test (${mode.kind === 'api' ? 'API key' : 'Claude subscription'})`);
  }

  if (cfg.baseline_must_pass && Object.keys(cfg.verify).length) {
    const v = runVerify(cfg, null, root, { dryRun: opts.dryRun });
    if (!v.passed) {
      const failed = v.results.find((r) => !r.passed);
      // "The script doesn't exist" and "the tests fail" are different problems with
      // different fixes. On a fresh install it is almost always the former.
      const notRunnable =
        failed.code === 127 ||
        /missing script|command not found|not recognized as|no such file or directory/i.test(failed.output);
      if (notRunnable) {
        problems.push(
          `verify command "${failed.name}" can't run in this project: \`${failed.cmd}\`\n` +
            `    Edit the "verify" block in nightshift.config.json to use your project's real commands.`
        );
      } else if (failed.timedOut) {
        problems.push(
          `verify command "${failed.name}" timed out after ${cfg.verify_timeout_sec}s. ` +
            `Raise verify_timeout_sec, or use a faster command as the gate.`
        );
      } else {
        problems.push(
          `baseline is red — "${failed.name}" fails on the current commit. Fix it before starting; ` +
            `otherwise every task tonight will be blamed for a pre-existing failure.`
        );
      }
    } else {
      notes.push(`baseline green (${v.results.length} gate${v.results.length === 1 ? '' : 's'})`);
    }
  }

  return { problems, notes, pendingCount: pending.length };
}

// ---------------------------------------------------------------------------
// run state / logging
// ---------------------------------------------------------------------------

function makeRun(root, cfg, opts) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = `${stamp}${opts.dryRun ? '-dryrun' : ''}`;
  const dir = path.join(root, '.nightshift', 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  return {
    id,
    dir,
    logPath: path.join(dir, 'run.jsonl'),
    startedAt: Date.now(),
    deadline: Date.now() + cfg.caps.wall_clock_hours * 3600 * 1000,
    spend: 0,
    consecutiveFailures: 0,
    infraFailures: 0,
    tasks: [],
    abortReason: null,
  };
}

function logEvent(run, event) {
  fs.appendFileSync(run.logPath, JSON.stringify({ at: ts(), ...event }) + '\n');
}

// ---------------------------------------------------------------------------
// caps / circuit breaker
// ---------------------------------------------------------------------------

function checkCaps(run, cfg) {
  const caps = cfg.caps;
  if (Date.now() >= run.deadline)
    return `wall-clock cap reached (${caps.wall_clock_hours}h)`;
  if (run.spend >= caps.total_budget_usd)
    return `budget cap reached ($${run.spend.toFixed(2)} of $${caps.total_budget_usd})`;
  if (run.consecutiveFailures >= caps.max_consecutive_failures)
    return `${run.consecutiveFailures} consecutive failures — stopping rather than draining the queue`;
  if (run.infraFailures >= caps.max_infra_failures)
    return `${run.infraFailures} infrastructure failures (auth expired, API down, or CLI missing) — stopping immediately`;
  return null;
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

function nextTask(plan) {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const t of plan.tasks) {
    if (t.status !== 'pending') continue;
    const unmet = t.depends_on.filter((d) => byId.get(d)?.status !== 'done');
    if (unmet.length) continue;
    return t;
  }
  return null;
}

function blockDependents(plan, run) {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of plan.tasks) {
      if (t.status !== 'pending') continue;
      const dead = t.depends_on.filter((d) => {
        const dep = byId.get(d);
        return dep && dep.status !== 'done' && dep.status !== 'pending';
      });
      if (dead.length) {
        t.status = 'skipped';
        t.blocked_reason = `dependency ${dead.join(', ')} did not complete`;
        logEvent(run, { event: 'task_skipped', task: t.id, reason: t.blocked_reason });
        changed = true;
      }
    }
  }
}

function savePlan(planPath, plan) {
  fs.writeFileSync(planPath, serializePlan(plan));
}

function commitTask(root, task, planPath, cfg) {
  const subject = `${task.id}: ${task.title}`;
  const body = [
    task.result?.summary ? task.result.summary : '',
    '',
    `nightshift-task: ${task.id}`,
    `nightshift-verified: ${task.verifyNames?.join(', ') || 'none'}`,
  ]
    .join('\n')
    .trim();
  git(['add', '-A'], root);
  const r = git(['commit', '-m', subject, '-m', body], root);
  if (r.code !== 0) return null;
  return headSha(root);
}

function commitPlanUpdate(root, message) {
  const r = git(['status', '--porcelain'], root);
  if (!r.stdout) return null;
  git(['add', '-A'], root);
  const c = git(['commit', '-m', message], root);
  if (c.code !== 0) return null;
  return headSha(root);
}

function runLoop({ root, cfg, plan, planPath, run, opts }) {
  const baseSha = headSha(root);
  run.baseSha = baseSha;

  while (true) {
    const capBreach = checkCaps(run, cfg);
    if (capBreach) {
      run.abortReason = capBreach;
      err(`Stopping: ${capBreach}`);
      logEvent(run, { event: 'abort', reason: capBreach });
      break;
    }

    const task = nextTask(plan);
    if (!task) break;

    rule();
    const remaining = plan.tasks.filter((t) => t.status === 'pending').length;
    info(`${bold(task.id)} ${task.title} ${dim(`(${remaining} pending)`)}`);

    const checkpoint = headSha(root);
    const forbiddenBefore = snapshotForbidden(root, cfg.forbidden_paths);
    task.attempts = (task.attempts || 0) + 1;
    logEvent(run, { event: 'task_start', task: task.id, checkpoint });

    const started = Date.now();
    const agent = callAgent(task, cfg, root, opts);
    const cost = agent.envelope?.total_cost_usd || 0;
    run.spend += cost;
    task.cost_usd = (task.cost_usd || 0) + cost;

    // Wall time and the session's own accounting can diverge sharply — a task once
    // took 28 minutes for a 90-second session. Log both so the gap is attributable
    // instead of just mysterious the next morning.
    logEvent(run, {
      event: 'agent_done',
      task: task.id,
      durationMs: agent.durationMs,
      sessionMs: agent.envelope?.duration_ms ?? null,
      apiMs: agent.envelope?.duration_api_ms ?? null,
      numTurns: agent.envelope?.num_turns ?? null,
      cost_usd: cost,
    });

    fs.writeFileSync(
      path.join(run.dir, `${task.id}.agent.json`),
      JSON.stringify({ envelope: agent.envelope, verdict: agent.verdict, error: agent.error }, null, 2)
    );

    // --- plan limit: wait for the window, don't burn the night ---------------
    // On a Claude subscription this is the expected way a long run ends early.
    // Waiting costs nothing but clock; aborting costs every remaining task.
    if (agent.planLimit) {
      const now = Date.now();
      const DEFAULT_WAIT_MS = 20 * 60 * 1000;
      const until = agent.planLimit.resetAt && agent.planLimit.resetAt > now
        ? agent.planLimit.resetAt
        : now + DEFAULT_WAIT_MS;

      resetTo(checkpoint, root);
      task.status = 'pending'; // untouched — it gets a clean retry after the wait

      // Without a ceiling, a limit that keeps reasserting itself spins this task
      // until the wall-clock deadline and silently eats the whole queue.
      task.planLimitWaits = (task.planLimitWaits || 0) + 1;
      const maxWaits = cfg.caps.max_plan_limit_waits ?? 3;
      if (task.planLimitWaits > maxWaits) {
        run.abortReason = `plan limit persisted across ${maxWaits} waits — stopping so the queue is retried on a fresh window`;
        err(run.abortReason);
        logEvent(run, { event: 'plan_limit_abort', task: task.id, waits: task.planLimitWaits, reason: 'max_waits' });
        break;
      }

      if (until >= run.deadline) {
        run.abortReason = `plan limit reached; window reopens after the run deadline (${new Date(until).toLocaleTimeString()})`;
        err(run.abortReason);
        logEvent(run, { event: 'plan_limit_abort', task: task.id, until, detail: agent.planLimit.detail });
        break;
      }

      const waitMs = until - now;
      warn(
        `plan limit reached — waiting ${Math.ceil(waitMs / 60000)} min until ${new Date(until).toLocaleTimeString()}, then retrying ${task.id}`
      );
      logEvent(run, { event: 'plan_limit_wait', task: task.id, waitMs, until, detail: agent.planLimit.detail });
      run.planLimitWaits = (run.planLimitWaits || 0) + 1;
      run.planLimitMs = (run.planLimitMs || 0) + waitMs;
      sleepSync(waitMs);
      continue; // same task, fresh session
    }

    // --- infrastructure failure: fast, repeated, and not the task's fault -----
    if (agent.infra) {
      run.infraFailures += 1;
      run.consecutiveFailures += 1;
      resetTo(checkpoint, root);
      task.status = 'pending'; // not the task's fault — leave it runnable
      err(`infrastructure failure: ${agent.error}`);
      logEvent(run, { event: 'infra_failure', task: task.id, error: agent.error, durationMs: agent.durationMs });
      continue;
    }

    // A non-infra error that returned suspiciously fast is almost always infra.
    const floorMs = cfg.caps.min_task_duration_sec * 1000;
    if (agent.error && agent.durationMs < floorMs) {
      run.infraFailures += 1;
      run.consecutiveFailures += 1;
      resetTo(checkpoint, root);
      task.status = 'pending';
      err(`agent failed in ${agent.durationMs}ms (below ${cfg.caps.min_task_duration_sec}s floor) — treating as infrastructure: ${agent.error}`);
      logEvent(run, {
        event: 'infra_failure',
        task: task.id,
        error: agent.error,
        durationMs: agent.durationMs,
        reason: 'below_duration_floor',
      });
      continue;
    }

    if (agent.error) {
      resetTo(checkpoint, root);
      task.status = 'blocked';
      task.blocked_reason = `agent error: ${agent.error.slice(0, 300)}`;
      run.consecutiveFailures += 1;
      err(`agent error: ${agent.error.slice(0, 200)}`);
      logEvent(run, { event: 'task_blocked', task: task.id, reason: task.blocked_reason });
      savePlan(planPath, plan);
      commitPlanUpdate(root, `chore(nightshift): mark ${task.id} blocked`);
      continue;
    }

    const verdict = agent.verdict || { status: 'partial', summary: '(agent returned no structured verdict)' };
    task.result = verdict;

    // --- agent self-declared block: a good outcome, not a failure -------------
    if (verdict.status === 'blocked') {
      resetTo(checkpoint, root);
      task.status = 'blocked';
      task.blocked_reason = verdict.blocker_question || verdict.summary || 'agent reported blocked';
      task.question = verdict.blocker_question || null;
      run.consecutiveFailures += 1;
      warn(`blocked: ${task.blocked_reason.slice(0, 160)}`);
      logEvent(run, { event: 'task_blocked', task: task.id, reason: task.blocked_reason, question: task.question });
      savePlan(planPath, plan);
      commitPlanUpdate(root, `chore(nightshift): mark ${task.id} blocked`);
      continue;
    }

    // --- guard: agent must not touch protected paths --------------------------
    // Two checks, because neither alone is sufficient: git status catches tracked and
    // untracked changes, the snapshot catches gitignored files like .env.
    const touched = changedPaths(root);
    const statusHit = touched.map((p) => [p, matchesForbidden(p, cfg.forbidden_paths)]).find(([, m]) => m);
    const snapHit = forbiddenTouched(root, cfg.forbidden_paths, forbiddenBefore);
    if (statusHit || snapHit) {
      const [hitPath, hitPattern] = statusHit || [snapHit, snapHit];
      resetTo(checkpoint, root);
      task.status = 'blocked';
      task.blocked_reason = `touched forbidden path ${hitPath} (matches "${hitPattern}")`;
      run.consecutiveFailures += 1;
      err(`forbidden path: ${hitPath}`);
      logEvent(run, { event: 'forbidden_path', task: task.id, path: hitPath, pattern: hitPattern });
      savePlan(planPath, plan);
      commitPlanUpdate(root, `chore(nightshift): mark ${task.id} blocked`);
      continue;
    }

    // --- guard: the agent must never rewrite its own queue --------------------
    const planRel = path.relative(root, planPath);
    if (touched.includes(planRel)) {
      git(['checkout', '--', planRel], root);
      warn(`agent modified ${planRel} — reverted (the runner owns the queue)`);
      logEvent(run, { event: 'plan_write_reverted', task: task.id });
    }

    if (!changedPaths(root).length) {
      task.status = 'blocked';
      task.blocked_reason = 'agent made no file changes';
      run.consecutiveFailures += 1;
      err('agent produced no changes');
      logEvent(run, { event: 'task_blocked', task: task.id, reason: task.blocked_reason });
      savePlan(planPath, plan);
      commitPlanUpdate(root, `chore(nightshift): mark ${task.id} blocked`);
      continue;
    }

    // --- THE GATE: the runner verifies. The agent's claim is advisory. --------
    const verifyStarted = Date.now();
    const v = runVerify(cfg, task, root, opts);
    task.verifyNames = v.results.filter((r) => r.passed).map((r) => r.name);
    fs.writeFileSync(path.join(run.dir, `${task.id}.verify.json`), JSON.stringify(v, null, 2));
    logEvent(run, {
      event: 'verify_done',
      task: task.id,
      durationMs: Date.now() - verifyStarted,
      passed: v.passed,
    });

    if (!v.passed) {
      const failed = v.results.find((r) => !r.passed);
      resetTo(checkpoint, root);
      task.status = 'blocked';
      task.blocked_reason = `verify "${failed.name}" failed (exit ${failed.code})`;
      task.verify_output = failed.output;
      run.consecutiveFailures += 1;
      err(`verify "${failed.name}" failed — reverted to ${checkpoint.slice(0, 8)}`);
      if (verdict.status === 'done') {
        warn('agent claimed done but verification disagreed — this is exactly what the gate is for');
      }
      logEvent(run, {
        event: 'verify_failed',
        task: task.id,
        gate: failed.name,
        code: failed.code,
        agentClaimed: verdict.status,
      });
      savePlan(planPath, plan);
      commitPlanUpdate(root, `chore(nightshift): mark ${task.id} blocked`);
      continue;
    }

    // --- success --------------------------------------------------------------
    task.status = 'done';
    savePlan(planPath, plan); // status update rides along in the task commit
    const sha = commitTask(root, task, planPath, cfg);
    task.commit = sha ? sha.slice(0, 8) : null;
    task.diffstat = sha ? diffStat(checkpoint, sha, root) : '';
    task.durationMs = Date.now() - started;
    run.consecutiveFailures = 0;
    run.infraFailures = 0;
    ok(
      `${task.id} done ${dim(
        `${task.commit || '(no commit)'} · ${(task.durationMs / 1000).toFixed(0)}s · $${cost.toFixed(2)}`
      )}`
    );
    logEvent(run, {
      event: 'task_done',
      task: task.id,
      commit: task.commit,
      cost,
      durationMs: task.durationMs,
      gates: task.verifyNames,
    });
  }

  blockDependents(plan, run);
  savePlan(planPath, plan);
  commitPlanUpdate(root, 'chore(nightshift): final plan status');
  return run;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

function writeReport({ root, cfg, plan, run, opts, branch }) {
  const done = plan.tasks.filter((t) => t.status === 'done');
  const blocked = plan.tasks.filter((t) => t.status === 'blocked');
  const skipped = plan.tasks.filter((t) => t.status === 'skipped');
  const pending = plan.tasks.filter((t) => t.status === 'pending');
  const mins = Math.round((Date.now() - run.startedAt) / 60000);
  const questions = blocked.filter((t) => t.question);

  const L = [];
  L.push(`# Night report — ${new Date().toISOString().slice(0, 10)}`);
  L.push('');
  if (opts.dryRun) L.push('> **DRY RUN** — no agent was called and no real work was done.', '');
  L.push(
    `**${done.length} of ${plan.tasks.length} tasks completed** in ${mins} min · ` +
      `$${run.spend.toFixed(2)} spent · branch \`${branch}\``
  );
  L.push('');
  if (run.abortReason) {
    L.push(`> ⚠️ **Run stopped early:** ${run.abortReason}`);
    L.push('');
  }

  L.push('## Review this first');
  L.push('');
  if (questions.length) {
    L.push(`The agent stopped rather than guess on ${questions.length} decision${questions.length === 1 ? '' : 's'}:`);
    L.push('');
    for (const t of questions) L.push(`- **${t.id}** (${t.title}) — ${t.question}`);
  } else {
    L.push('No decisions were escalated.');
  }
  L.push('');
  L.push('```bash');
  L.push(`git diff ${run.baseSha.slice(0, 8)}..HEAD`);
  L.push(`git log --oneline ${run.baseSha.slice(0, 8)}..HEAD`);
  L.push('```');
  L.push('');

  if (done.length) {
    L.push('## Completed');
    L.push('');
    for (const t of done) {
      L.push(`### ${t.id} — ${t.title}`);
      L.push('');
      L.push(`\`${t.commit || 'uncommitted'}\` · verified by: ${t.verifyNames?.join(', ') || 'none'} · $${(t.cost_usd || 0).toFixed(2)}`);
      if (t.result?.summary) L.push('', t.result.summary);
      if (t.diffstat) L.push('', '```', t.diffstat.trim(), '```');
      L.push('');
    }
  }

  if (blocked.length) {
    L.push('## Blocked');
    L.push('');
    for (const t of blocked) {
      L.push(`### ${t.id} — ${t.title}`);
      L.push('');
      L.push(`**Why:** ${t.blocked_reason || 'unknown'}`);
      L.push('', 'The working tree was reset — nothing from this task is on the branch.');
      if (t.verify_output) {
        L.push('', '<details><summary>verify output</summary>', '', '```', t.verify_output.slice(-2000), '```', '', '</details>');
      }
      L.push('');
    }
  }

  if (skipped.length) {
    L.push('## Skipped (blocked dependency)');
    L.push('');
    for (const t of skipped) L.push(`- **${t.id}** ${t.title} — ${t.blocked_reason}`);
    L.push('');
  }

  if (pending.length) {
    L.push('## Never reached');
    L.push('');
    for (const t of pending) L.push(`- **${t.id}** ${t.title}`);
    L.push('');
  }

  L.push('## Run details');
  L.push('');
  L.push(`- Base commit: \`${run.baseSha}\``);
  L.push(`- Branch: \`${branch}\` (never pushed, base branch untouched)`);
  L.push(`- Model: ${cfg.model}${cfg.fallback_model ? ` (fallback: ${cfg.fallback_model})` : ''}`);
  L.push(`- Spend: $${run.spend.toFixed(2)} of $${cfg.caps.total_budget_usd} cap`);
  L.push(`- Log: \`${path.relative(root, run.logPath)}\``);
  L.push('');

  const out = path.join(root, cfg.report_file);
  fs.writeFileSync(out, L.join('\n'));
  return out;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function resolveContext(opts) {
  const cwd = opts.cwd || process.cwd();
  const root = repoRoot(cwd);
  if (!root) fatal(`Not a git repository: ${cwd}\nnightshift needs git — every guardrail is built on commits.`);
  const cfg = loadConfig(root, opts.config);
  const planPath = path.isAbsolute(opts.plan || '')
    ? opts.plan
    : path.join(root, opts.plan || cfg.plan_file);
  return { root, cfg, planPath };
}

function loadPlanOrDie(planPath) {
  if (!fs.existsSync(planPath)) {
    fatal(
      `No plan at ${planPath}\n\n` +
        `Create one by running Claude Code in this repo and using the /night-plan skill,\n` +
        `or copy templates/NIGHT_PLAN.md and fill it in by hand.`
    );
  }
  return parsePlan(fs.readFileSync(planPath, 'utf8'));
}

function cmdPreflight(opts) {
  const { root, cfg, planPath } = resolveContext(opts);
  const plan = loadPlanOrDie(planPath);
  info(`repo: ${root}`);
  info(`plan: ${path.relative(root, planPath)} (${plan.tasks.length} tasks)`);
  const pf = preflight(root, cfg, plan, opts);
  for (const n of pf.notes) ok(n);
  for (const p of pf.problems) err(p);
  if (pf.problems.length) {
    rule();
    err(`${pf.problems.length} problem${pf.problems.length === 1 ? '' : 's'} — not safe to run`);
    return 1;
  }
  rule();
  ok(`ready — ${pf.pendingCount} pending task${pf.pendingCount === 1 ? '' : 's'}`);
  return 0;
}

function cmdRun(opts) {
  const { root, cfg, planPath } = resolveContext(opts);
  const plan = loadPlanOrDie(planPath);

  log('');
  log(bold(`nightshift ${VERSION}`) + (opts.dryRun ? yellow('  [dry run — no agent calls, no spend]') : ''));
  info(`repo: ${root}`);
  info(`plan: ${path.relative(root, planPath)} (${plan.tasks.length} tasks)`);
  rule();

  const pf = preflight(root, cfg, plan, opts);
  for (const n of pf.notes) ok(n);
  if (pf.problems.length) {
    for (const p of pf.problems) err(p);
    rule();
    fatal(`preflight failed — refusing to start.\nFix the above and re-run. Nothing was changed.`);
  }

  // isolated branch, always
  const baseBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root).stdout;
  let branch = `${cfg.branch_prefix}${new Date().toISOString().slice(0, 10)}`;
  if (opts.dryRun) branch += '-dryrun';
  let n = 1;
  while (git(['rev-parse', '--verify', '--quiet', branch], root).code === 0) {
    n += 1;
    branch = `${cfg.branch_prefix}${new Date().toISOString().slice(0, 10)}${opts.dryRun ? '-dryrun' : ''}-${n}`;
  }
  gitOrDie(['checkout', '-b', branch], root);
  ok(`branch ${cyan(branch)} from ${baseBranch} — ${baseBranch} will not be touched`);

  const run = makeRun(root, cfg, opts);
  run.branch = branch;
  run.baseBranch = baseBranch;
  logEvent(run, { event: 'run_start', branch, baseBranch, tasks: plan.tasks.length, dryRun: !!opts.dryRun });
  // "est." matters: on a subscription these dollars are never charged, and a user
  // who reads them as a bill will size the caps wrong in both directions.
  const est = authMode().kind === 'subscription' ? ' est.' : '';
  info(
    `caps: ${cfg.caps.wall_clock_hours}h · $${cfg.caps.total_budget_usd}${est} total · $${cfg.caps.per_task_budget_usd}${est}/task · ` +
      `${cfg.caps.max_consecutive_failures} consecutive failures`
  );

  let interrupted = false;
  const onSig = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    run.abortReason = 'interrupted by user (SIGINT)';
    warn('interrupt received — finishing current task, then writing the report');
  };
  process.on('SIGINT', onSig);

  try {
    runLoop({ root, cfg, plan, planPath, run, opts });
  } finally {
    const reportPath = writeReport({ root, cfg, plan, run, opts, branch });
    // The report is a run artifact; commit it so the branch is self-describing.
    commitPlanUpdate(root, 'chore(nightshift): night report');
    logEvent(run, { event: 'run_end', spend: run.spend, abortReason: run.abortReason });

    const done = plan.tasks.filter((t) => t.status === 'done').length;
    const blocked = plan.tasks.filter((t) => t.status === 'blocked').length;
    rule();
    log('');
    log(
      `  ${bold(`${done} done`)} · ${blocked} blocked · $${run.spend.toFixed(2)} · ` +
        `${Math.round((Date.now() - run.startedAt) / 60000)} min`
    );
    log(`  branch  ${cyan(branch)}`);
    log(`  report  ${cyan(path.relative(root, reportPath))}`);
    log('');
    log(dim(`  git diff ${run.baseSha.slice(0, 8)}..HEAD`));
    log('');
  }

  // Exit codes are what a wrapping script or cron job reads:
  //   0 = everything landed  ·  2 = ran to completion with blocked tasks
  //   3 = a cap or the circuit breaker stopped the run early
  if (run.abortReason) return 3;
  return plan.tasks.some((t) => t.status === 'blocked') ? 2 : 0;
}

function cmdDemo(opts) {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const src = path.join(path.dirname(here), 'examples', 'demo-project');
  if (!fs.existsSync(src)) fatal(`Demo project not found at ${src}`);

  const dest = opts.demoDir || path.join(process.cwd(), 'nightshift-demo');
  if (fs.existsSync(dest)) {
    fatal(`${dest} already exists. Remove it or pass --demo-dir <path>.`);
  }
  fs.cpSync(src, dest, { recursive: true });
  const g = (a) => git(a, dest);
  g(['init', '-q', '-b', 'main']);
  g(['add', '-A']);
  const commit = spawnSync(
    'git',
    ['-c', 'user.name=nightshift', '-c', 'user.email=nightshift@localhost', 'commit', '-q', '-m', 'demo baseline'],
    { cwd: dest, encoding: 'utf8' }
  );
  if (commit.status !== 0) fatal(`Could not create demo repo: ${commit.stderr}`);

  const self = process.argv[1];
  log('');
  ok(`demo project created at ${cyan(dest)}`);
  log('');
  log('  A real git repo with a real, currently-green test suite and a 6-task queue');
  log('  seeded to exercise every outcome: done, blocked, skipped, reverted.');
  log('');
  log(dim('  Watch the whole loop with no agent calls and no spend:'));
  log(`    node ${self} run --dry-run --cwd ${dest}`);
  log('');
  log(dim('  Then for real:'));
  log(`    node ${self} run --cwd ${dest}`);
  log('');
  return 0;
}

function cmdStatus(opts) {
  const { root, cfg, planPath } = resolveContext(opts);
  const plan = loadPlanOrDie(planPath);
  const counts = {};
  for (const t of plan.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  log('');
  log(bold(path.relative(process.cwd(), planPath)));
  log('');
  for (const t of plan.tasks) {
    const badge =
      t.status === 'done'
        ? green('done   ')
        : t.status === 'blocked'
        ? red('blocked')
        : t.status === 'skipped'
        ? yellow('skipped')
        : dim('pending');
    log(`  ${badge}  ${bold(t.id)}  ${t.title}`);
    if (t.blocked_reason) log(`           ${dim(t.blocked_reason)}`);
  }
  log('');
  log(
    '  ' +
      Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(' · ')
  );
  log('');
  return 0;
}

const HELP = `${bold('nightshift')} ${VERSION} — unattended, verified overnight progress for Claude Code

${bold('USAGE')}
  nightshift <command> [options]

${bold('COMMANDS')}
  run              Work the queue in NIGHT_PLAN.md on an isolated branch
  preflight        Run the safety checks only, change nothing
  status           Show the current queue and task statuses
  demo             Create a sandbox demo project you can run against
  help             This

${bold('OPTIONS')}
  --dry-run        Stub every agent call. Exercises the full loop for $0.
  --cwd <dir>      Operate on this repo instead of the current directory
  --plan <path>    Plan file (default: NIGHT_PLAN.md)
  --config <path>  Config file (default: nightshift.config.json)
  --demo-dir <p>   Where the demo command writes the sandbox project

${bold('THE CONTRACT')}
  The agent proposes, the runner verifies. A task is only "done" when the
  runner's own verify commands pass — never because the agent said so.
  Failed tasks are hard-reset to their checkpoint, so every commit is green.
  Work happens on a fresh branch. Nothing is ever pushed.

${bold('EXAMPLES')}
  nightshift preflight
  nightshift run --dry-run
  nightshift run
`;

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--cwd') opts.cwd = path.resolve(argv[++i]);
    else if (a === '--plan') opts.plan = argv[++i];
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--demo-dir') opts.demoDir = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a.startsWith('-')) fatal(`Unknown option: ${a}`);
    else opts._.push(a);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(red(e.message));
    return 1;
  }
  if (opts.version) {
    log(VERSION);
    return 0;
  }
  const cmd = opts._[0] || 'help';
  if (opts.help || cmd === 'help') {
    log(HELP);
    return 0;
  }
  const table = { run: cmdRun, preflight: cmdPreflight, status: cmdStatus, demo: cmdDemo };
  const fn = table[cmd];
  if (!fn) {
    console.error(red(`Unknown command: ${cmd}`));
    log(HELP);
    return 1;
  }
  return fn(opts);
}

try {
  process.exitCode = main() || 0;
} catch (e) {
  if (e instanceof Fatal) {
    console.error('\n' + red('✗ ') + e.message + '\n');
    process.exitCode = 1;
  } else {
    throw e;
  }
}
