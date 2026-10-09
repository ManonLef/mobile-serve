# Mobile Serve

A small extension that gives you a QR code and URL to use on your mobile phone to test your project
in real time, without having to look up your computer's IP address or dev server port.

This extension does *not* show a simulated phone inside VS Code. It finds the dev server running on
your computer, works out the address your phone can reach it on over Wi-Fi, and shows that address
as a QR code. Scan the code with your phone's camera and the page opens in your phone's own browser:
real touch, real screen size, real Safari or Chrome.

## Instructions

1. Start your dev server as usual (`npm run dev`, Live Server's **Go Live**, `python3 -m http.server`, …).
2. Click **📱 Mobile** in the status bar, or run **Mobile Serve: Show Phone URL** from the Command Palette.
3. Pick the server from the list. Servers started from the open project are listed first.
4. Scan the QR code with your phone. Your phone has to be on the same Wi-Fi network as your computer.

The panel also shows whether the server is listening on that address (checked from your computer,
so a firewall can still block the phone), and lists other addresses to try
if your computer is on more than one network.

## When the server only listens on localhost

Most dev servers only accept connections from your own computer by default, so your phone can't
reach them. Mobile Serve tells you when that's the case and helps you fix it:

- **Vite, Astro, Nuxt, Next.js, Angular CLI, webpack-dev-server and Vue CLI:** it reads your
  `package.json`, shows the command that restarts the server on your network
  (for example `npm run dev -- --host`), and can restart it for you, in the terminal it was running in.
  It only offers this when the server was started with a `package.json` script (`npm run dev`,
  `pnpm dev`, …), that script runs just that one tool, and the tool is the one that's running.
- **Live Server:** it can switch Live Server's host setting to `0.0.0.0` for this workspace. It never
  changes the setting for all of VS Code, so open the folder you're serving first. The setting is saved
  in the workspace settings (usually `.vscode/settings.json`), so take care not to commit it.
- **Docker:** published container ports are listed too. A port published on `127.0.0.1` only has to
  be published on all interfaces instead (`-p 3000:3000`).
- **Anything else:** it shows example commands, and you can still show the QR code anyway.

## Things that work differently on a phone

The page runs in your phone's browser, so it makes its requests *from the phone*. Apps that call
an API or backend sometimes need a small change:

- **Requests to `localhost`.** On the phone, `localhost` means the phone itself. A front end that
  calls `http://localhost:8000/api` will fail. Use relative URLs (`/api`) together with your dev
  server's proxy (for example Vite's `server.proxy`), or use your computer's network address.
- **The backend only listening on localhost.** If the phone calls your API directly, the API server
  needs to listen on your network too, just like the dev server.
- **CORS.** The page's origin becomes something like `http://192.168.1.20:5173` instead of
  `http://localhost:5173`. A backend that only allows `localhost` will reject the requests.
  A dev server proxy avoids this, because the browser then only talks to one origin.
- **Cookies and sign-in.** Cookies set for `localhost` don't apply to the network address, and
  cookies marked `Secure` aren't saved over plain `http`. OAuth providers usually reject redirect
  URLs that aren't registered, so sign-in flows may need the network address added.
- **Browser features that need HTTPS.** Browsers only treat `localhost` as secure. On a network
  address over `http`, features such as service workers, camera and microphone, geolocation, the
  clipboard API and `crypto.subtle` are unavailable. Serve over HTTPS to test them on the phone
  (for example with `@vitejs/plugin-basic-ssl`). Mobile Serve detects HTTPS and shows an
  `https://` address; your phone will ask you to accept a self-signed certificate.

## Requirements

- VS Code 1.82 or newer.
- macOS or Linux to detect running servers (it uses `lsof`, which some Linux distributions don't
  install by default). On Windows you can still type the port in by hand.
- Your phone and computer on the same network. On macOS, allow incoming connections if the
  firewall asks.
- With Remote SSH, WSL or Dev Containers, the addresses shown belong to the remote machine, which
  your phone may not be able to reach. The panel warns you when this applies.

## Security

Making a server reachable from your phone makes it reachable from every device on that network.
Avoid doing this on public or untrusted Wi-Fi, and stop the server when you're done.

In Restricted Mode (untrusted workspaces) the extension won't restart servers for you, because
that runs scripts from the project's `package.json`.

## Licenses

Mobile Serve is MIT-licensed. The packages bundled into the extension are listed with their licenses
in `dist/THIRD_PARTY_NOTICES.txt`, which the build generates.

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## Development

Needs Node.js 22.18 or newer. Run `npm install`, then:

- **F5** builds the extension and starts a VS Code window with it loaded.
- `npm test` runs the unit tests. Node runs the TypeScript files directly.
- `npm run check` type-checks the code.
- `npx @vscode/vsce package` builds the `.vsix`.

The source in `src/` is TypeScript using ES modules. esbuild bundles it into a single CommonJS
file, `dist/extension.js`, because that's the format VS Code loads extensions in.
