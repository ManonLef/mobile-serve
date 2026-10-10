# Changelog

## Unreleased

- A project in a subfolder can be started too: when the open folder has no dev script or page of
  its own, Mobile Serve offers the ones up to two folders deep, such as a monorepo's `apps/web` or
  the web app next to a .NET API.
- The picker keeps the highlighted item when its list of running servers is filled in.
- Live reload no longer breaks a plain HTML page that has `</body>` inside a script.
- Opening a folder without the trailing slash always redirects to the same server.
- The picker, messages and QR code page say "your network" or "other devices" where they said
  "your phone", since any device can open the page. **Start ‹folder› for your phone** is now
  **Start ‹folder› on your network**.

## 0.2.0 - 2026-10-10

The first public release.

- **Show Phone URL** gives a QR code and a URL that open your project on any device on your network.
  The panel shows whether the server is listening on that address and lists other addresses to try.
- Starts Vite, Astro, Nuxt, Next.js, Angular CLI, webpack-dev-server and Vue CLI projects from their
  `package.json` script, with the flags that make them listen on your network.
- Serves plain HTML folders itself, and reloads the page on every device when you save.
- Finds dev servers that are already running in the project (macOS and Linux), or takes a port you
  enter.
- When a server only listens on localhost, it can restart it on your network, or switch Live
  Server's host setting for the workspace.
- **Close Mobile** stops what Mobile Serve started and puts back what it changed.
- **Show Log** shows what Mobile Serve did, for reporting a problem.
