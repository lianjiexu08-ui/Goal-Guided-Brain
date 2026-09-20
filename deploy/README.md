# Deployment

These are deployment templates. The repository's automated tests exercise local HTTP and MCP fixtures; they do not certify a production cloud deployment or Windows/Linux execution on the current macOS host.

## Requirements

- Node.js 22.13 or newer, npm, Git and a supported DSH executable on execution nodes.
- Linux for an always-on control plane; macOS, Linux, or a Linux distribution under WSL2 for execution nodes. Native Windows processes are not supported by the process-group cancellation code.
- A persistent volume for the controller database, artifacts and encrypted credentials. Maintain a separate backup of vault unlock material.
- A DNS name and inbound TCP 80/443 for Caddy certificate issuance. Keep application ports 3088 and 3089 bound to loopback.

## Linux Control Plane

1. Create a dedicated `dsh` account. Place the checkout in `/opt/dsh-workbench`, the writable data directory in `/var/lib/dsh-workbench`, and local project mappings under `/srv/dsh-projects`. Grant the service account ownership of its writable directories.
2. Run `npm ci`, `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build` from the checkout before installing the service.
3. Prepare `/etc/dsh-workbench.env` using `control.env.example`. Set `WORKBENCH_PUBLIC_URL` to the exact HTTPS origin and choose a unique owner password. Keep this file root-owned with mode `0600`; systemd reads it before dropping privileges. Do not place credentials in the repository.
4. Install `dsh-workbench.service` in `/etc/systemd/system/`. Adjust `ExecStart` to the installed Node.js binary and ensure it meets the required version. Run `systemctl daemon-reload` and `systemctl enable --now dsh-workbench`.
5. Install Caddy, supply `WORKBENCH_DOMAIN` to its service environment, and install the supplied Caddy configuration. Run `caddy validate --config /etc/caddy/Caddyfile` before reloading Caddy.
6. Open the configured HTTPS URL and sign in. Verify the unauthenticated API returns `401`, login cookies are `HttpOnly`, `SameSite=Strict`, and `Secure`, and direct public access to ports 3088/3089 is blocked.

The initial password is stored as an Argon2id hash. Once initialization succeeds, remove `WORKBENCH_OWNER_PASSWORD` from the environment file; the stored owner account remains valid. There is no anonymous remote account-creation endpoint. Changing the password from an authenticated session revokes existing sessions.

The HTTP proxy must preserve the request Host and Origin. Do not trust arbitrary forwarded headers from the public network. Access logs must exclude request bodies, Authorization headers and cookies. Restart the service and verify data persists before assigning important tasks.

## Execution Node

1. Install the same application revision and dependencies on the node. Configure DSH using the installation process appropriate for that machine.
2. Create a private node data directory and a JSON config based on `node.example.json`. The `workspaces` object maps logical names to absolute directories on this node. Use a separate data directory outside every source project.
3. In the control plane, create a pairing code. Pair from the node using:

   ```sh
   node scripts/node.mjs --config /etc/dsh-node.json --pair YOUR_ONE_TIME_CODE --name my-node
   ```

4. Pairing codes expire after ten minutes and can be used once. Pairing starts the node worker. Stop this foreground process before starting the installed service. The node saves its identity in `node-identity.json` with mode `0600`; do not share this file or include it in public diagnostics.
5. On Linux, install `dsh-node.service` after adjusting its paths and account. Start it with `systemctl enable --now dsh-node`. On macOS, run the command in a managed terminal or configure a user LaunchAgent with the actual Node.js path.
6. Choose the registered node and its workspace mapping when creating a task. An absolute workspace path sent by the controller never replaces the node's local mapping. Every development attempt receives its own managed worktree or snapshot and temporary directory.

Nodes establish outbound HTTPS connections. Heartbeats occur every ten seconds; execution leases last sixty seconds. A node that cannot renew its lease stops the associated runtime. Completion results remain in a local SQLite outbox until accepted; late results rejected by the controller remain in `rejected_results` for inspection. Remote model credentials are supplied only for the assigned run and must not be logged or copied into shared artifacts.

Selected Skill and plugin files are transferred with the assignment as bounded, content-addressed bundles. The node validates their hash and maps control-plane paths to its own cache. Executable dependencies used by those bundles must still be installed on the execution node.

MCP connections currently run through the control-plane tool gateway. A configured stdio command therefore runs on the controller, including when its requesting Agent runs on a remote node. Node-local stdio servers are not yet supported; do not configure a node-only absolute path as a controller MCP command. Remote HTTP MCP servers can expose node-hosted tools when that endpoint is reachable from the controller.

The gateway enforces an optional exact tool-name allowlist. An empty list permits discovering every advertised tool. A tool declaring `readOnlyHint: true` is treated as read-only under the owner's trust in the selected provider; that annotation is not independent proof of safety. Other tools require an explicit grant for the tool and argument set before invocation. Unknown results remain blocked pending inspection, and repeated successful calls return the saved result. These checks govern MCP calls and do not make arbitrary third-party terminal scripts a security boundary.

## Windows With WSL2

Use a Linux Node.js installation and Linux DSH executable inside WSL2. Keep source and execution directories in the Linux filesystem, for example `/home/user/projects`, rather than a Windows-mounted repository when reliable Git permissions and process handling matter. Paths in the node configuration must use Linux syntax.

Run the same node command inside WSL2. For a persistent service, enable systemd in the distribution and use the Linux node unit after adjusting its user and paths. WSL and the Windows host must both remain running for local node work to continue. Always-on monitoring should target a cloud node or the cloud controller.

## Recovery And Verification

- Pause schedules and drain or stop active work before migrating controller data. Back up the complete data directory using the application's consistent backup mechanism; copying a live SQLite main file alone can omit WAL transactions.
- Import once into the destination controller and start only that controller as the scheduler authority. Do not run two controllers against copied databases with active schedules.
- Re-pair nodes if their controller URL changes. Revoke old node identities after migration. Preserve worktrees and result outboxes until outstanding executions are reconciled.
- Test a controller restart, node disconnection, revoked node token, failed task, and timed monitor before relying on unattended operation. `state_unknown` means the previous execution needs inspection; it is not a signal to repeat an external operation.
- Use `journalctl -u dsh-workbench` and `journalctl -u dsh-node` for service events. Verify logs contain no login password, model key, node token, or credential plaintext.

Successful local tests do not replace these checks against the actual deployment target. Production rollout, real model calls and cross-platform verification require the intended host and configured credentials.
