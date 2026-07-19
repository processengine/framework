// Pure command plan for making locally built images available to a kind cluster.
//
// Docker Desktop's Kubernetes shares the host Docker image store, so nothing extra
// is needed there. A kind node runs its own containerd, so host images must be
// explicitly loaded with `kind load docker-image` BEFORE Helm references them —
// otherwise pods fail with ImagePullBackOff under imagePullPolicy: IfNotPresent.
//
// This function returns the exact commands to run (empty for docker-desktop), so
// the plan is unit-testable without a cluster.

export function kindClusterName(context) {
  const match = /^kind-(.+)$/u.exec(context);
  return match ? match[1] : undefined;
}

export function kindLoadPlan(context, images) {
  const cluster = kindClusterName(context);
  if (!cluster) return []; // docker-desktop (or any non-kind context): no loading
  return images.map((image) => ({
    program: 'kind',
    args: ['load', 'docker-image', image.image, '--name', cluster],
  }));
}
