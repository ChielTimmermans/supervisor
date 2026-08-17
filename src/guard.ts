// Defense-in-depth guard for investigation workers: reject Bash commands that
// would MUTATE the cluster or monitoring backends. Cluster RBAC is the real
// enforcement boundary; this catches the direct/accidental cases and gives the
// agent immediate feedback so it self-corrects. It inspects command strings and
// is intentionally conservative — it is NOT a sandbox and does not defend
// against obfuscation (e.g. `k=kubectl; $k delete`, base64-piped-to-sh).

export type GuardResult = { blocked: true; reason: string } | { blocked: false };

const ALLOW: GuardResult = { blocked: false };

// Mutating subcommands per cluster CLI. Anything not listed is treated as read-only.
const WRITE_VERBS: Record<string, Set<string>> = {
  kubectl: new Set([
    'apply', 'create', 'delete', 'edit', 'patch', 'replace', 'scale', 'cordon',
    'drain', 'uncordon', 'taint', 'annotate', 'label', 'set', 'exec', 'cp',
    'expose', 'autoscale', 'run', 'debug', 'attach',
  ]),
  helm: new Set(['install', 'upgrade', 'uninstall', 'delete', 'rollback', 'push']),
  argocd: new Set(['sync', 'delete', 'create', 'set', 'rollback', 'terminate-op']),
  flux: new Set(['reconcile', 'suspend', 'resume', 'delete', 'create', 'install', 'uninstall', 'bootstrap']),
  istioctl: new Set(['install', 'uninstall']),
};
// oc (OpenShift) shares kubectl's grammar and verbs.
WRITE_VERBS.oc = WRITE_VERBS.kubectl;

// `kubectl rollout <sub>` mutates only for these sub-actions; `status`/`history` are reads.
const ROLLOUT_WRITE_SUBS = new Set(['restart', 'undo', 'pause', 'resume']);

// Global flags that consume the following token as their value (so it isn't the verb).
const VALUE_FLAGS = new Set([
  'n', 'namespace', 'context', 'cluster', 'kubeconfig', 'user', 'as', 'as-group',
  'token', 'server', 's', 'request-timeout', 'cache-dir', 'tls-server-name',
  'certificate-authority', 'client-key', 'client-certificate',
]);

const MUTATING_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// curl/wget flags that carry a request body (and thus imply a write).
const HTTP_BODY_FLAGS = new Set([
  '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '-F', '--form', '-T', '--upload-file',
]);

function basename(bin: string): string {
  const slash = bin.lastIndexOf('/');
  return slash === -1 ? bin : bin.slice(slash + 1);
}

/** Strip leading `sudo`, `env`, and VAR=value assignments; return the remaining tokens. */
function stripPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && (tokens[i] === 'sudo' || tokens[i] === 'env' || /^[A-Za-z_]\w*=/.test(tokens[i]))) i++;
  return tokens.slice(i);
}

/** Find the subcommand verb after `kubectl`/`helm`/etc., skipping global flags and their values. */
function verbAfter(tokens: string[], start: number): { verb?: string; index: number } {
  let j = start;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.startsWith('-')) {
      const name = t.replace(/^-+/, '').split('=')[0];
      j += !t.includes('=') && VALUE_FLAGS.has(name) ? 2 : 1;
      continue;
    }
    return { verb: t, index: j };
  }
  return { index: j };
}

function deny(cli: string, action: string): GuardResult {
  return { blocked: true, reason: `Blocked: read-only investigation may not run \`${cli} ${action}\`. Diagnose only; propose fixes as code, not cluster changes.` };
}

function inspectClusterCli(cli: string, tokens: string[], cliIndex: number): GuardResult {
  const { verb, index } = verbAfter(tokens, cliIndex + 1);
  if (!verb) return ALLOW;
  if (cli === 'kubectl' || cli === 'oc') {
    if (verb === 'rollout') {
      const sub = verbAfter(tokens, index + 1).verb;
      return sub && ROLLOUT_WRITE_SUBS.has(sub) ? deny(cli, `rollout ${sub}`) : ALLOW;
    }
  }
  // argocd uses `argocd <resource> <action>` — the mutating action is the second word.
  if (cli === 'argocd') {
    const action = verbAfter(tokens, index + 1).verb;
    return action && WRITE_VERBS.argocd.has(action) ? deny(cli, `${verb} ${action}`) : ALLOW;
  }
  return WRITE_VERBS[cli].has(verb) ? deny(cli, verb) : ALLOW;
}

function inspectHttp(tool: string, tokens: string[]): GuardResult {
  for (let k = 1; k < tokens.length; k++) {
    const t = tokens[k];
    // -X POST / --request DELETE
    if (t === '-X' || t === '--request') {
      const method = (tokens[k + 1] ?? '').toUpperCase();
      if (MUTATING_HTTP_METHODS.has(method)) return { blocked: true, reason: `Blocked: read-only investigation may not send a ${method} request. Monitoring reads use GET.` };
    }
    // -XPOST / --request=DELETE (inline)
    const inline = t.match(/^(?:-X|--request=?)([A-Za-z]+)$/);
    if (inline && MUTATING_HTTP_METHODS.has(inline[1].toUpperCase())) {
      return { blocked: true, reason: `Blocked: read-only investigation may not send a ${inline[1].toUpperCase()} request. Monitoring reads use GET.` };
    }
    // request-body flags imply a write
    const flagName = t.split('=')[0];
    if (HTTP_BODY_FLAGS.has(flagName)) {
      return { blocked: true, reason: `Blocked: read-only investigation may not send a request body (${flagName}). Monitoring reads use GET without a body.` };
    }
  }
  return ALLOW;
}

/** Split a command line into segments on shell separators so a write hidden after `&&`/`;`/`|` is still seen. */
function segments(command: string): string[] {
  return command.split(/(?:\|\||&&|;|\||\n)/g).map((s) => s.trim()).filter(Boolean);
}

/**
 * Inspect a Bash command for cluster/monitoring MUTATIONS. Returns `{ blocked: true, reason }`
 * for cluster-CLI write verbs or mutating HTTP calls, otherwise `{ blocked: false }`.
 * Only cluster tooling is in scope; local file edits, git, builds, and reads pass through.
 */
export function inspectBashCommand(command: string): GuardResult {
  for (const seg of segments(command)) {
    const tokens = stripPrefixes(seg.split(/\s+/).filter(Boolean));
    if (!tokens.length) continue;
    const bin = basename(tokens[0]);
    if (bin in WRITE_VERBS) {
      const r = inspectClusterCli(bin, tokens, 0);
      if (r.blocked) return r;
    } else if (bin === 'curl' || bin === 'wget') {
      const r = inspectHttp(bin, tokens);
      if (r.blocked) return r;
    }
  }
  return ALLOW;
}
