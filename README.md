# PR Panel for GitHub

Chrome side panel listing open GitHub PRs awaiting your review and PRs you authored.

## Features

- CI checks and review status per PR
- Toolbar badge with the number of review requests, or `!` when you're logged out or an org's SSO session has expired
- Banners for login, SSO, rate limit and connection problems, with a faster refresh after re-authenticating
- A banner for each of your orgs whose IP allow list blocks your current IP, since GitHub leaves their PRs out of
  search without saying so
- Clicking a PR focuses its tab if it's already open; Cmd/Ctrl-click or middle-click opens it in the background

## Install

Requires [Bun](https://bun.sh).

```sh
bun install
bun run build
```

Open `chrome://extensions`, enable Developer mode, click **Load unpacked** and select `dist/`. Click the toolbar icon to open the panel.

To build a Chrome Web Store upload ZIP, run `bun run package`. This rebuilds `dist/` and writes
`releases/github-pr-panel-<version>.zip`, with `manifest.json` at the archive root. ZIP packaging uses
`fflate` as a development dependency; it isn't bundled into the extension.

## How it works

No token needed: the extension uses your GitHub browser session and reads the data GitHub embeds in its `/pulls/search` page. That format is internal, so a GitHub change can break parsing; the panel then shows a "Couldn't load PRs" banner with "Unexpected page format" and the field that failed.

Search queries and refresh intervals are configurable from the gear icon.

## Privacy

See the [privacy policy](PRIVACY.md) for data handling.

## Development

```sh
bun run typecheck
bun fmt --check   # formatting and import order
bun fmt           # apply formatting
bun test
```

## License

[MIT](LICENSE). Icons in `assets/icons/` are from [GitHub Octicons](https://github.com/primer/octicons),
also under [MIT](assets/icons/LICENSE).
