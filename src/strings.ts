// The text Mobile Serve shows: the picker, the status bar, notifications and the QR code page.
// It's all here so the wording can be read, and one day translated, in one place. Kept free of
// VS Code, so any module can use it. Log messages are for bug reports and stay where they're
// logged; command titles are in package.json.

const LOCALHOST_ONLY = 'This server only listens on localhost, so other devices on your network can\'t reach it.';

export const strings = {
  picker: {
    title: 'What do you want to share on your network?',
    looking: 'Looking for running servers…',
    startOrPick: 'Start this project on your network, or pick a running server',
    pickOrEnterPort: 'Pick a running server, or enter a port',
    enterRunningPort: 'Enter the port of a running server',
    start: (folder: string) => `Start ${folder} on your network`,
    staticPlan: 'Serves the folder\'s HTML, CSS and JavaScript',
    staticDetail: 'Reloads the page when you save, like Go Live',
    scriptDetail: 'Runs in a terminal, reachable from your network',
    shared: (port: number) => `Shared on port ${port}`,
    showAgain: 'Show the QR code again',
    running: 'Running in this project',
    reachable: 'Reachable from your network',
    localhostOnly: 'Listening on localhost only',
    enterPort: 'Enter a port…',
    portPrompt: 'Port number',
    portInvalid: 'Enter a port between 1 and 65535, like 4200',
    manual: 'Manual',
    noServers: 'No servers running in this project',
    noDetectionOnWindows: 'Detecting servers isn\'t supported on Windows',
    detectionFailed: (reason: string) => `Couldn't look for running servers (${reason})`,
    lsofNotInstalled: 'lsof isn\'t installed, so running servers can\'t be detected. Install it, for example with `sudo apt install lsof`.',
    lsofUnavailable: 'lsof isn\'t available, so running servers can\'t be detected.',
  },

  statusBar: {
    show: 'Mobile',
    showTooltip: 'Show a QR code to open a local dev server on another device',
    close: (ports: number[]) => `Close Mobile: ${ports.join(', ')}`,
    closeTooltip: (ports: number[]) =>
      (ports.length > 1
        ? `Ports ${ports.join(', ')} are reachable from every device on your network. Click to stop sharing them.`
        : `Port ${ports.join(', ')} is reachable from every device on your network. Click to stop sharing it.`) +
      '\n\nTo show the QR code again, run “Mobile Serve: Show Phone URL”.',
    copied: (url: string) => `Copied ${url}`,
  },

  errors: {
    failed: (reason: string) => `Mobile Serve: ${reason}`,
    showLog: 'Show Log',
    noNetwork: 'No network connection found. Connect to Wi-Fi and try again.',
    notSharing: 'Mobile Serve isn\'t sharing anything on your network.',
  },

  // When the chosen server only listens on localhost.
  makeReachable: {
    showAnyway: 'Show Anyway',
    liveServer: `${LOCALHOST_ONLY} Live Server needs its host setting changed to 0.0.0.0.`,
    openFolderDetail: 'Open the folder you\'re serving and try again, so the setting can be changed for that workspace only.',
    fixLiveServer: 'Fix Live Server Setting',
    fixLiveServerDetail: 'This makes Live Server reachable from any device on your network for this workspace. ' +
      'The setting is saved in the workspace settings (usually .vscode/settings.json), so take care not to commit it.',
    liveServerFixed: 'Live Server host set to 0.0.0.0. Stop and restart Go Live, then try again.',
    restartServer: 'Restart Server',
    restartWith: (command: string) => `${LOCALHOST_ONLY} Restart it with “${command}” to make it reachable.`,
    restartDetail: 'Restarting stops the current server, as Ctrl+C in its terminal would, and starts it again with that command.',
    restartByHand: `${LOCALHOST_ONLY} Restart it bound to all interfaces, e.g. “npm run dev -- --host” (Vite), ` +
      '“ng serve --host 0.0.0.0” or “python3 -m http.server --bind 0.0.0.0”.',
  },

  start: {
    // The name of the terminal the dev script runs in, with the project's path when it's below the folder.
    taskName: (script: string, project?: string) => `${project ? `${project}: ` : ''}${script} (network)`,
    starting: (command: string) => `Starting “${command}” on your network…`,
    stoppedEarly: (terminal: string) => `The dev server stopped before other devices could reach it. Check the “${terminal}” terminal.`,
    notReachableYet: (seconds: number, terminal: string) => `The dev server isn't reachable after ${seconds} seconds. ` +
      `It keeps starting in the “${terminal}” terminal: show the phone URL again once it's up.`,
    portTaken: (port: number, script: string) =>
      `Port ${port}, which the “${script}” script uses, is already taken. Stop what's using it and try again.`,
  },

  restart: {
    terminalName: 'Dev server (network)',
    restarting: (command: string) => `Restarting the dev server with “${command}”…`,
    restartingLocally: (command: string) => `Restarting the dev server with “${command}”, for this computer only…`,
    alreadyRestarting: (port: number) => `The server on port ${port} is already restarting.`,
    alreadyStopped: (port: number, command: string) => `The server on port ${port} has already stopped. Start it with “${command}”.`,
    portUsedByOthers: (port: number, pids: number[], command: string) =>
      `Port ${port} is also used by another process (pid ${pids.join(', ')}). Stop the server yourself and run “${command}”.`,
    stillInUse: (port: number, command: string) =>
      `Port ${port} is still in use. Something may have restarted the server; stop it yourself and run “${command}”.`,
    startFailed: (reason: string, command: string) =>
      `The server was stopped, but starting it again failed: ${reason}. Start it with “${command}”.`,
    notReachable: (seconds: number, terminal: string) =>
      `The dev server didn't become reachable within ${seconds} seconds. Check the “${terminal}” terminal.`,
  },

  // What Close Mobile and Stop Sharing report.
  close: {
    startingLocally: (command: string) => `The dev server is starting again for this computer only (“${command}”).`,
    liveServerStopped: 'Live Server is stopped and set back to this computer only. Click Go Live to start it again.',
    liveServerStillRunning: 'Live Server is set back to this computer only, but is still running on your network. Stop it and click Go Live again.',
    liveServerRestored: 'Mobile Serve set Live Server back to this computer only: VS Code closed while it was shared on your network.',
    cantStopTask: (port: number) => `Mobile Serve can't stop the server on port ${port}. Stop it in its terminal with Ctrl+C.`,
    failedPort: (port: number, reason: string) => `port ${port} (${reason})`,
    // `failures` are failedPort texts.
    failed: (failures: string[]) => `Couldn't stop sharing ${failures.join(', ')}. Click Close Mobile to try again.`,
  },

  // The QR code page. These go into its HTML as they are, so values have to be escaped first.
  page: {
    qrAlt: (url: string) => `QR code for ${url}`,
    copyUrl: 'Copy URL',
    listening: '✓ The server is listening on this address.',
    notListening: '⚠ Couldn\'t connect on this address. Is the server running and bound to 0.0.0.0?',
    https: 'The server uses HTTPS. If its certificate is self-signed, the other device will ask you to accept it.',
    remote: (remoteName: string) => `⚠ VS Code is connected to a remote environment (${remoteName}). ` +
      'These addresses belong to that machine, which devices on your network may not be able to reach.',
    sharedByMobileServe: '⚠ Every device on this network can open this server while it\'s shared.',
    stopSharing: 'Stop Sharing',
    sharedByOther: '⚠ Every device on this network can open this server. Mobile Serve didn\'t set that up, ' +
      'so stop the server yourself when you\'re done.',
    hint: 'Scan the QR code with the device\'s camera, or type in the URL. The device has to be on the same network as your computer. ' +
      'If the page doesn\'t load, allow incoming connections in your computer\'s firewall, and avoid guest ' +
      'networks, which often block devices from reaching each other.',
    otherAddresses: 'Other addresses:',
  },
};
