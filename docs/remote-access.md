# Private Fleet access from a phone or tablet

Remote access runs inside Fleet on your Mac and is off by default. Viewing a session uses the existing Claude/Codex process and conversation. It does not launch another agent. New session explicitly launches one on the Mac in a currently known or favourite project.

## Setup

1. Install Tailscale on the Mac and your phone/tablet and sign in to the same account. Keep the Mac awake, online, and Fleet running. Fleet does not change sleep settings.
2. Restrict your tailnet access policy to your own devices. Fleet also requires the exact `Tailscale-User-Login` configured below; devices belonging to other logins are rejected. This login check is account-based; device restrictions belong in your Tailscale policy. Do not enable Funnel.
3. Run `tailscale serve status --json` and inspect existing mappings. Choose an unused HTTPS port. Do not overwrite an existing endpoint or run a global Serve reset.
4. In Fleet Settings → Remote access, enter the exact private HTTPS origin, your Tailscale login, and an unused local port (default 43180). Enable remote access. Local service running means the loopback listener is ready; it does not prove the Tailscale mapping or device policy is ready.
5. Run the displayed Serve command for the chosen port. For example, when port 443 is unused:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:43180
   tailscale serve status --json
   ```

   Use the exact hostname reported by Serve as the Fleet address, e.g. `https://your-mac.your-tailnet.ts.net`, without a trailing slash. Fleet binds only to `127.0.0.1`; never expose its local HTTP port directly.
6. Connect Tailscale on the mobile device, then scan the QR code. The QR is generated locally and contains only the saved private URL. No ticket or credential is encoded, and no external QR service receives the address. Add the page to your home screen if desired.

Official references: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and [Serve examples](https://tailscale.com/docs/reference/examples/serve).

## Using sessions

The mobile list follows Fleet's existing discovery. An external session may be view only when Fleet cannot verify a controllable tmux binding. Select a conversation, send a reply, answer a prompt, or open Terminal. New session shows your favourite folders, offers known projects, and accepts an optional name for either provider; mobile cannot browse arbitrary Mac directories.

Desktop and mobile have independent selected-session watchers and terminal attachments. One Fleet device at a time controls each terminal. Observers see the owner's terminal dimensions and can choose Take control. Closing a browser connection releases only that device's resources; it does not kill the agent. Other terminal programs outside Fleet are outside Fleet's ownership arbitration.

Drafts and selection live in the mobile browser's storage, separate from desktop preferences. On a lost acknowledgment Fleet preserves the draft and says the action may have been sent. Check the conversation or terminal before manually retrying. Reconnection refreshes reads and subscriptions; it never automatically replays replies, approvals, launches, or raw terminal input. There is no offline action queue or service worker.

Uploads, Mac file browsing, permission-mode changes, and Codex recovery controls remain desktop features. Existing prompt cards and Markdown rendering are shared with desktop; transcript HTML is not executed, and links open with opener isolation.

## Development website previews

In Remote access settings, add the project's absolute folder, a label, its running development server's local port, and a private preview HTTPS origin. It must use this Mac's Tailscale hostname with a different HTTPS port from Fleet. Each preview needs its own Serve mapping; Fleet does not discover ports, start servers, or change Serve mappings.

Example with Fleet on HTTPS 443 and a project on local port 3000, after verifying HTTPS 8443 is free:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3000
tailscale serve status --json
```

Save `https://your-mac.your-tailnet.ts.net:8443` as the preview URL. The mobile view shows a link only for the selected project. Fleet checks whether the configured loopback port accepts connections; this is a reachability check, not proof that the website or its backend is healthy.

Preview pages are a different origin from Fleet and cannot obtain Fleet's socket tickets or send authenticated controls. Fleet uses no authentication cookies. Preview links use `noopener noreferrer`.

Project-specific setup still matters: allow exactly the private hostname in the development server's host allowlist; keep backend calls on a reachable private origin or an existing same-origin development proxy. If live reload needs configuration, use the project's installed server version to configure secure WebSockets for the preview's external HTTPS port. OAuth callbacks must match the private preview URL. Do not use unrestricted CORS or `allowedHosts: true`. The actual project's host/HMR/backend configuration must be checked during device acceptance.

## Limits and troubleshooting

- Fleet settings are saved atomically in `~/.llm-workspace/remote.json`; malformed config starts no remote listener and produces a settings error.
- A rejected connection usually means the wrong hostname, login, Tailscale connection, or Serve mapping. Direct access to the loopback port without trusted proxy headers is rejected.
- A running local process can impersonate the loopback proxy. This design trusts the Mac and its local processes; Tailscale headers protect the remote boundary.
- Eight concurrent browser connections, bounded messages/queues, per-connection rate limits, single-use bootstrap tickets, and heartbeat cleanup protect the Mac from abandoned or slow tabs.
- Disabling remote access closes browser connections and their watchers/PTYs. It leaves the tmux agents running. Quitting Fleet drains remote operations before closing its databases.
- Build both renderers with `npm run build:app`. The mobile bundle ships under `out/mobile` and works without a Vite development server. `npm run dist:mac` packages both.

## Acceptance record

Implementation is in the `feat/private-mobile-access` worktree. Automated checks cover private configuration, origin/login/ticket checks, real HTTP/WebSocket traffic, input receipts, session identity changes, multi-client subscriptions, terminal ownership and disposable real tmux detach/size behavior, preserved uncertain drafts, and local QR encoding.

Pending real-device acceptance: Tailscale sign-in and private policy, actual Serve mappings, Wi-Fi and cellular access, phone/tablet keyboard behavior, existing Claude/Codex replies and approvals, new sessions, simultaneous different Codex views, suspension/reconnect without duplicated input, and an actual project's backend/live reload. No claim of successful device access until these checks pass.

The existing running Fleet process was observed starting October 9, 2026 at 09:45:40 local time; it does not contain this feature. It has not been restarted by this implementation.

Automated acceptance on October 14: **3,406 tests pass** across 160 files; TypeScript checking and both production renderer builds pass. An independent security/correctness review found five important issues; each was fixed with regression coverage (identity/display consistency, bounded terminal delivery, action capacity under read load, desktop input coordination, visible terminal refusals). Mutation metadata diagnostics remain a minor follow-up. Browser fixture layouts were inspected at 390px and 820px, including favourites and session naming. These checks do not replace the pending real-device checklist above.
