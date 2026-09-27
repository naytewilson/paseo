# Provider fidelity across upgrades

The maintained source includes ACP per-model effort discovery, provider-acknowledged
reasoning selection, composer selection reconciliation, and lossless coalescing of
sparse tool lifecycle updates. Generic ACP catalog discovery queries each unresolved
model in its disposable probe session, within a ten-second budget. Providers may
disable this with `params.probeModelThinkingOptions: false`; explicit provider
resolvers take precedence. Unacknowledged or timed-out choices remain unresolved.

Run `npm run test:provider-fidelity` before accepting an upstream update. The normal
server prepack and release-check paths invoke this gate. The gate fails if a named
regression suite disappears. Server typecheck/build and client/browser checks remain
required; this focused gate does not replace them.

Updates must be built from a revision retaining these changes. An upstream npm
`@getpaseo/cli@latest` install or a vendor desktop auto-update does **not** contain a
local fork commit merely because the old installation was repaired. Do not claim
durability from edited `node_modules`, an archive edit, or an exact-version preload.

Release acceptance is per host: anvil-node-02 (ANVIL Dell Node), anvil-node-01
(ANVIL HP Node), and naytes-macbook-neo (Neo). Record the source commit, package
digest, active service entrypoint, runtime version, per-model catalog readback,
reasoning/tool stream evidence, and actual client rendering on each host.
Stage and check a candidate before replacing a runtime; retain its previous package
and service configuration for rollback. A source test or one host's success does
not close another host's acceptance gate.

Current deployment limitation: the vendor updater still targets upstream releases.
This source gate protects builds from this fork; it is not yet a replacement for
the three hosts' vendor update channels. Channel integration and an actual upgrade
exercise must pass before the repair is labelled durable in production.
