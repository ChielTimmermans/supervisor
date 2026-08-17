import { describe, it, expect } from 'vitest';
import { inspectBashCommand } from '../src/guard.js';

function block(cmd: string): string | undefined {
  const r = inspectBashCommand(cmd);
  return r.blocked ? r.reason : undefined;
}

describe('inspectBashCommand — allowed read-only diagnosis', () => {
  it('allows kubectl read verbs', () => {
    expect(inspectBashCommand('kubectl get pods -n prod').blocked).toBe(false);
    expect(inspectBashCommand('kubectl describe pod api-0 -n prod').blocked).toBe(false);
    expect(inspectBashCommand('kubectl logs api-0 -n prod --tail=100').blocked).toBe(false);
    expect(inspectBashCommand('kubectl top pods -n prod').blocked).toBe(false);
  });

  it('allows helm/argocd/flux read subcommands', () => {
    expect(inspectBashCommand('helm list -n prod').blocked).toBe(false);
    expect(inspectBashCommand('argocd app get myapp').blocked).toBe(false);
    expect(inspectBashCommand('flux get kustomizations').blocked).toBe(false);
  });

  it('allows a GET curl to a monitoring endpoint', () => {
    expect(inspectBashCommand('curl -s "$PROM_URL/api/v1/query?query=up"').blocked).toBe(false);
    expect(inspectBashCommand('curl -s -H "Authorization: Bearer $GLITCHTIP_TOKEN" "$GLITCHTIP_URL/api/0/issues/"').blocked).toBe(false);
  });

  it('allows non-cluster shell commands', () => {
    expect(inspectBashCommand('git log --oneline -20').blocked).toBe(false);
    expect(inspectBashCommand('grep -rn TODO src/').blocked).toBe(false);
    expect(inspectBashCommand('npm test').blocked).toBe(false);
  });

  it('does not treat a label value of "delete" as a write verb', () => {
    expect(inspectBashCommand('kubectl get pods -l app=delete -n prod').blocked).toBe(false);
  });
});

describe('inspectBashCommand — blocked cluster writes', () => {
  it('blocks kubectl mutating verbs', () => {
    expect(block('kubectl delete pod api-0 -n prod')).toMatch(/kubectl/i);
    expect(inspectBashCommand('kubectl apply -f deploy.yaml').blocked).toBe(true);
    expect(inspectBashCommand('kubectl patch deploy api -p "{}"').blocked).toBe(true);
    expect(inspectBashCommand('kubectl scale deploy api --replicas=0').blocked).toBe(true);
    expect(inspectBashCommand('kubectl rollout restart deploy/api -n prod').blocked).toBe(true);
    expect(inspectBashCommand('kubectl edit deploy api').blocked).toBe(true);
    expect(inspectBashCommand('kubectl drain node-1').blocked).toBe(true);
    expect(inspectBashCommand('kubectl exec api-0 -- sh -c "rm -rf /"').blocked).toBe(true);
  });

  it('blocks oc mutating verbs', () => {
    expect(inspectBashCommand('oc delete pod api-0').blocked).toBe(true);
  });

  it('blocks helm/argocd/flux mutating subcommands', () => {
    expect(inspectBashCommand('helm upgrade api ./chart').blocked).toBe(true);
    expect(inspectBashCommand('helm uninstall api').blocked).toBe(true);
    expect(inspectBashCommand('argocd app sync myapp').blocked).toBe(true);
    expect(inspectBashCommand('flux reconcile kustomization apps').blocked).toBe(true);
  });

  it('honors mutating verbs after global flags', () => {
    expect(inspectBashCommand('kubectl -n prod --context staging delete pod api-0').blocked).toBe(true);
  });

  it('blocks a write hidden after a shell separator', () => {
    expect(inspectBashCommand('echo hi && kubectl delete pod api-0').blocked).toBe(true);
    expect(inspectBashCommand('kubectl get pods; kubectl delete pod api-0').blocked).toBe(true);
    expect(inspectBashCommand('true || helm uninstall api').blocked).toBe(true);
  });

  it('allows a read even when piped to another command', () => {
    expect(inspectBashCommand('kubectl get pods -o json | jq ".items | length"').blocked).toBe(false);
  });

  it('blocks sudo/env-prefixed cluster writes', () => {
    expect(inspectBashCommand('sudo kubectl delete ns prod').blocked).toBe(true);
    expect(inspectBashCommand('KUBECONFIG=/tmp/x kubectl delete pod api-0').blocked).toBe(true);
  });
});

describe('inspectBashCommand — blocked mutating HTTP', () => {
  it('blocks curl/wget with a mutating method', () => {
    expect(inspectBashCommand('curl -XPOST "$PROM_URL/-/reload"').blocked).toBe(true);
    expect(inspectBashCommand('curl -X DELETE "$GLITCHTIP_URL/api/0/issues/1/"').blocked).toBe(true);
    expect(inspectBashCommand('curl --request PUT "$PROM_URL/x"').blocked).toBe(true);
  });

  it('blocks curl with a request body', () => {
    expect(inspectBashCommand('curl -d "action=silence" "$PROM_URL/x"').blocked).toBe(true);
    expect(inspectBashCommand('curl --data-raw "{}" "$GLITCHTIP_URL/x"').blocked).toBe(true);
  });
});
