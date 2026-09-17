import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SieveLensScreen } from "@/sieve/sieve-lens-screen";

export default function SieveRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <SieveLensScreen />
    </HostRouteBootstrapBoundary>
  );
}
