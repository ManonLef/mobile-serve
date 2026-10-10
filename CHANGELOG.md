# Changelog

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
