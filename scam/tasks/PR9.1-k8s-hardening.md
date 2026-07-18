# Task Contract: PR9.1 — Kubernetes hardening (RBAC, NetworkPolicy, PodSecurity)

## Outcome
The reference Helm chart is hardened to enterprise baseline: default-deny network,
least-privilege RBAC, `restricted` Pod Security, external-secret guidance.

## Scope
- In: chart templates (NetworkPolicy, ServiceAccount/RBAC, securityContext),
  `docs/security/KUBERNETES.md`.
- Out: cluster-level policy engines.

## Affected module
`test-shop/deploy/helm/test-shop` (as reference).

## Acceptance — frozen
- [ ] Default-deny NetworkPolicies allow only required app↔Kafka↔PG flows.
- [ ] Pods run `runAsNonRoot`, drop all caps, no privilege escalation, seccomp
      RuntimeDefault; read-only rootfs where feasible.
- [ ] Chart passes a policy scan (e.g. polaris/kubescape) at a defined threshold.
- [ ] Contour still deploys green and passes `k8s:test`.

## Required tests
Policy-scan CI step; a green `k8s:test` on the hardened chart.

## Dependencies
PR8.1 (secrets). **Priority** P1 · **Size** M · **Blocks stable** no.

## Docs
`docs/security/KUBERNETES.md`.
