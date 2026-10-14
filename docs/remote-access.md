# Private Fleet access from a phone or tablet

Remote access runs inside Fleet on your Mac and is off by default. Viewing a session uses the existing Claude/Codex process and conversation. It does not launch another agent. New session explicitly launches one on the Mac in a currently known or favourite project.

## Which app to open

Use **`/Applications/Fleet.app`** on the Mac. This one app includes the desktop interface, the private remote service, and the mobile browser interface. There is no separate mobile Mac app to run. Open the saved private HTTPS address on your phone or tablet while Fleet and Tailscale are running on the Mac.

Build directories and feature worktrees are development outputs, not everyday launch locations. `npm run dist:mac` packages both interfaces into `dist/mac-arm64/Fleet.app`; install the verified bundle in `/Applications` and launch that copy. Quit the desktop app before replacing its installed bundle. Do not delete old build folders while an existing agent relay still uses them.

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

Mobile conversations use “Your messages in a bubble” by default: your messages are right-aligned in neutral bubbles and agent replies stay left-aligned without a margin rule.

Working sessions show the desktop’s rotating amber ring and an elapsed-time strip above the reply box. Sessions waiting on you show a coral alert icon and border; folder counts remain visible when collapsed. The persistent attention strip offers **Review request** to focus the question or approval, or **Open terminal** when no inline request is available. A nonblocking question says **Needs your input**. Activity indicators clear while disconnected. These indicators preserve the existing theme and background colours.

The mobile list follows Fleet's existing discovery. An external session may be view only when Fleet cannot verify a controllable tmux binding. Select a conversation, send a reply, answer a prompt, or open Terminal. New session shows your favourite folders, offers known projects, and accepts an optional name for either provider; mobile cannot browse arbitrary Mac directories.

Desktop and mobile have independent selected-session watchers and terminal attachments. One Fleet device at a time controls each terminal. Observers see the owner's terminal dimensions and can choose Take control. Closing a browser connection releases only that device's resources; it does not kill the agent. Other terminal programs outside Fleet are outside Fleet's ownership arbitration.

Drafts and selection live in the mobile browser's storage, separate from desktop preferences. On a lost acknowledgment Fleet preserves the draft and says the action may have been sent. Check the conversation or terminal before manually retrying. Reconnection refreshes reads and subscriptions; it never automatically replays replies, approvals, launches, or raw terminal input. There is no offline action queue or service worker.

Mac file browsing, permission-mode changes, and Codex recovery controls remain desktop features. Existing prompt cards and Markdown rendering are shared with desktop; transcript HTML is not executed, and links open with opener isolation.

## Attention and unread replies

Desktop and mobile have **Needs you** and **Updates** beside the normal session view. Needs you includes confirmed waiting-input and waiting-permission states across folders, ordered by when that device first observed the wait. Opening a session does not dismiss its pending request. Updates includes new main-thread agent replies; tool activity and your own messages do not create unread dots.

Read positions are separate on each device and survive reloads, keyed by provider and session ID. The initial session list establishes a quiet baseline. Replies are marked read only when the latest conversation is loaded, visible, and scrolled to the bottom. Terminal view, background tabs, and an offline mobile connection do not acknowledge them. The conversation marks the prior read boundary when available; if it is outside loaded history, it says so instead of inventing a position. Read state stores event IDs and fingerprints, not reply text, and retains up to 300 session records for 90 days.

On desktop, the bell opens **Notifications**. Alerts are off until enabled. Choose waiting-for-you alerts, optional working-to-idle alerts, and whether to alert only while Fleet is in the background. Names and reply previews are hidden by default; a selected session can be muted. Native notification clicks revalidate the session identity before opening it. Fleet quietly baselines sessions on startup and bounds bursts to three alerts in 30 seconds. Fleet must remain running; macOS notification permissions and Focus settings control delivery. Use **Send test notification** to check this Mac's settings.

Phone background push is not enabled by this update; the browser shows the live attention and unread views while connected.

Use **… → Close session** beside the reply box to stop the selected agent on the Mac after confirming its name. Fleet rechecks the process identity and terminal control before sending SIGTERM. The session stays listed if the agent has not exited. Closing the browser alone still leaves agents running.

The bottom toolbar places **Terminal** beside the bordered **image icon**; in terminal view it becomes **Conversation**. The **…** menu opens upward with Close session, Websites, and Copy session ID and PID (the same text format as desktop). Copy success or failure stays visible in the menu. Escape or tapping outside dismisses it.

Use the bordered **image icon** beside the reply box to pick up to four PNG, JPEG, GIF or WebP images, at most 10 MB each. Thumbnails can be removed before sending; image-only replies are supported. Images upload only when you press Send, using bounded HTTP requests with one-use tickets issued to that connection. The Mac validates the file bytes and binds staged IDs to the device and session. An uncertain send preserves the draft and thumbnails; inspect the conversation before retrying. Selected images stay in memory while reconnecting, but are not saved across page reloads or changing sessions. Unsent uploads are discarded on disconnect; files handed to the agent use the existing temporary attachment retention.

## Development website previews

In Remote access settings, add the project's absolute folder, a label, its running development server's local port, and a private preview HTTPS origin. It must use this Mac's Tailscale hostname with a different HTTPS port from Fleet. Each preview needs its own Serve mapping; Fleet does not discover ports, start servers, or change Serve mappings.

Example with Fleet on HTTPS 443 and a project on local port 3000, after verifying HTTPS 8443 is free:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3000
tailscale serve status --json
```

Save `https://your-mac.your-tailnet.ts.net:8443` as the preview URL. Open **… → Websites** beside the reply box to see links for the selected project. **Refresh websites** checks availability again. Fleet checks whether the configured loopback port accepts connections; this is a reachability check, not proof that the website or its backend is healthy.

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

The mobile feature was merged into the active base branch, `fix/preview-question-free-text`, on October 14, 2026. The merged build passed **3,427 tests across 161 files**, TypeScript checking, both production renderer builds, and macOS packaging. The verified bundle is installed and running at `/Applications/Fleet.app`.

Automated checks cover private configuration, origin/login/ticket validation, real HTTP/WebSocket traffic, input receipts, session identity changes, multi-client subscriptions, terminal ownership, disposable real tmux detach/size behavior, uncertain drafts, local QR encoding, image upload validation and revocation, and the Safari menu blur/copy event sequence. Close tests inject signals and never stop a live agent. Phone (390px) and tablet (820px) fixture layouts were inspected.

The user confirmed private phone access, new Claude/Codex sessions, folder grouping, image upload, and the updated conversation appearance. Browser verification copied and pasted fixture session details successfully; the clipboard fix still needs a phone Safari retest.

A project running locally on port 5173 has a private preview configured on HTTPS port 8443. Its page and Vite live reload connection were verified through that private address. After switching to the installed Fleet app, the Fleet page, authenticated bootstrap, and preview all returned HTTP 200; all 15 existing tmux panes retained their process IDs.

Further device checks include phone/tablet keyboard behavior, approvals, suspension/reconnect, image delivery to both providers, and any project-specific backend integration. These are not implied by the automated checks or HTTP availability checks above.
