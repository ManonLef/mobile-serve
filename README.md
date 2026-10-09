# Mobile Serve

A small extension that gives you a QR code and URL to use on your mobile phone to test your project
in real time, without having to look up your computer's IP address or dev server port. The URL works
on any other device on the same network too: a tablet, another computer, a colleague's phone.

This extension does *not* show a simulated phone inside VS Code. Like Live Server's **Go Live**, it
starts your project on your computer (or uses the dev server you already have running), works out the
address your phone can reach it on over Wi-Fi, and shows that address as a QR code. Scan the code
with your phone's camera and the page opens in your phone's own browser: real touch, real screen
size, real Safari or Chrome.

## Instructions

1. Click **📱 Mobile** in the status bar, or run **Mobile Serve: Show Phone URL** from the Command Palette.
2. Pick **Start ‹your project› for your phone** (see below). If your dev server is already running,
   you can pick it under **Running in this project** instead, or enter its port.
3. Scan the QR code with your phone. Your phone has to be on the same Wi-Fi network as your computer.
4. When you're done, click **📱 Close Mobile** in the status bar. It stops what Mobile Serve started,
   and puts back anything it made reachable from your network.

The panel also shows whether the server is listening on that address (checked from your computer,
so a firewall can still block the phone), and lists other addresses to try
if your computer is on more than one network.

## Starting your project

Mobile Serve looks at each open workspace folder and starts it the way that suits it:

- **Vite, Astro, Nuxt, Next.js, Angular CLI, webpack-dev-server and Vue CLI:** it runs your
  `package.json`'s `dev` script (or `start`, or `serve`) in a terminal, with the flags that make the
  tool listen on your network, for example `npm run dev -- --host --port 5173 --strictPort`. It uses
  the tool's usual port when it's free, so the address on your phone stays the same between runs.
  A script that already listens on your network (`vite --host`, `next dev -H 0.0.0.0`) only gets the port.
  Close Mobile, Ctrl+C or closing the terminal stops it. The script has to start the tool's dev
  server (`vite`, `next dev`, `ng serve`, `webpack serve`…): scripts that build or run a production
  server (`next start`, `vite preview`) aren't offered.
  Tested with Vite and Angular CLI so far. The others should work the same way, but haven't been
  tried yet; please open an issue if one doesn't.
- **Plain HTML, CSS and JavaScript:** a folder with an `index.html` and no build step is served by
  Mobile Serve itself, on port 5600. Like Go Live, it reloads the page on your phone when you save,
  and swaps the stylesheets in place when only CSS changed. A `package.json` whose only server is a
  static file server (`live-server`, `http-server`, `serve`…) counts as plain HTML too.

Projects it doesn't know how to start (a script that runs several commands, Django, Rails…) can
still be shown: start them yourself and pick them from the list, or enter the port.

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
- **Docker:** container ports aren't tied to a project folder, so enter the port. A port published on
  `127.0.0.1` only has to be published on all interfaces instead (`-p 3000:3000`).
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
  install by default). On Windows, starting your project works, and you can type in the port of a
  server that's already running.
- Your phone and computer on the same network. On macOS, allow incoming connections if the
  firewall asks.
- With Remote SSH, WSL or Dev Containers, the addresses shown belong to the remote machine, which
  your phone may not be able to reach. The panel warns you when this applies.

## Security

Making a server reachable from your phone makes it reachable from every device on that network.
Avoid doing this on public or untrusted Wi-Fi, and stop sharing when you're done: dev servers aren't
built to face a network, and Live Server serves every file in the folder, `.env` and `.git` included.
Mobile Serve's own server for plain HTML never serves files or folders whose name starts with a dot,
nor anything outside the folder.

**Close Mobile** undoes what Mobile Serve changed: it stops a server it started, restarts a server it
restarted with the original script, and puts Live Server's host setting back (stopping Live Server if it's running). A server
that was already reachable before Mobile Serve touched it is left alone; stop it yourself.

Closing VS Code puts Live Server's setting back too, since Live Server stops with it. If VS Code was
force quit or crashed, that happens the next time you open the workspace.

In Restricted Mode (untrusted workspaces) the extension won't start or restart servers for you,
because that runs scripts from the project's `package.json`. Plain HTML folders can still be served.

## Reporting a problem

Run **Mobile Serve: Show Log** from the Command Palette (or click **Show Log** on an error) to see
what Mobile Serve did: the servers it found, what it started or stopped, and what went wrong. Paste it
into an [issue](https://github.com/ManonLef/mobile-serve/issues), together with your operating system
and how you started your project. The log contains folder paths and process IDs, so look it over
first. It stays on your computer: Mobile Serve doesn't send anything anywhere.

For more detail, run **Developer: Set Log Level…**, choose Mobile Serve and then **Debug**.

## Licenses

Mobile Serve is MIT-licensed. The packages bundled into the extension are listed with their licenses
in `dist/THIRD_PARTY_NOTICES.txt`, which the build generates.

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## Development

Needs Node.js 22.18 or newer. Run `npm install`, then:

- **F5** builds the extension and starts a VS Code window with it loaded.
- `npm test` runs the unit tests. Node runs the TypeScript files directly.
- The smoke test runs the extension in a real VS Code: the current release and the oldest one
  `engines` allows (1.82). It opens a plain HTML folder, picks **Start ‹folder› for your phone**,
  checks the page is served with live reload, and that **Stop Sharing** stops it. It isn't part of CI,
  since it downloads VS Code each time: add the `smoke-test` label to a pull request to run it there
  (remove and add the label again to rerun). To try other versions, use **Actions → Smoke test → Run
  workflow**, or `gh workflow run smoke.yml --ref <branch> -f versions="stable 1.90.0"`.
  `npm run test:vscode` runs it locally, but downloads about 1.2 GB into `.vscode-test/`, which you
  can delete afterwards.
- `npm run check` type-checks the code.
- `npm run install-dev` builds the extension and installs it into your everyday VS Code
  (`~/.vscode/extensions`): over the installed copy if there is one, or else as `mobile-serve-dev`.
  Run **Developer: Reload Window** afterwards.
- `npx @vscode/vsce@4 package` builds the `.vsix`.

The source in `src/` is TypeScript using ES modules. esbuild bundles it into a single CommonJS
file, `dist/extension.js`, because that's the format VS Code loads extensions in. The small `package.json`
files in `src/`, `test/` and `scripts/` only set `"type": "module"`, so Node runs those folders as ES
modules while the root package, and with it `dist/extension.js`, stays CommonJS.
