# Contributing to Mobile Serve

Needs Node.js 22.18 or newer. Run `npm install`, then:

- **F5** builds the extension and starts a VS Code window with it loaded.
- `npm test` runs the unit tests. Node runs the TypeScript files directly.
- The smoke test runs the extension in a real VS Code: the current release and the oldest one
  `engines` allows (1.82). It opens a plain HTML folder, picks **Start ‹folder› on your network**,
  checks the page is served with live reload, and that **Stop Sharing** stops it. It runs on every
  pull request. To try other versions, use **Actions → Smoke test → Run workflow**, or
  `gh workflow run smoke.yml --ref <branch> -f versions="stable 1.90.0"`.
  `npm run test:vscode` runs it locally, but downloads about 1.2 GB into `.vscode-test/`, which you
  can delete afterwards.
- `npm run check` type-checks the code.
- `npm run lint` checks it with ESLint, formatting included. `npm run lint -- --fix` applies the
  formatting.
- `npm run install-dev` builds the extension and installs it into your everyday VS Code
  (`~/.vscode/extensions`): over the installed copy if there is one, or else as `mobile-serve-dev`.
  Run **Developer: Reload Window** afterwards.
- `npx @vscode/vsce@4 package` builds the `.vsix`.

Most of the logic is in modules that don't import `vscode` (`shares.ts`, `projectStart.ts`,
`restartCommand.ts`, `processes.ts`, `servers.ts`, `staticServer.ts`…), so the unit tests run them in
plain Node. The modules that do import it (`sharing.ts`, `start.ts`, `restart.ts`, `extension.ts`…)
gather what those need to know, then show the dialogs, run the tasks and stop the processes. New
logic goes in the first kind, with a test.

The text Mobile Serve shows (the picker, the status bar, notifications and the QR code page) is in
`strings.ts`, so new wording goes there too. Log messages stay where they're logged.

The source in `src/` is TypeScript using ES modules. esbuild bundles it into a single CommonJS
file, `dist/extension.js`, because that's the format VS Code loads extensions in. The small `package.json`
files in `src/`, `test/` and `scripts/` only set `"type": "module"`, so Node runs those folders as ES
modules while the root package, and with it `dist/extension.js`, stays CommonJS.
