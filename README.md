# agentic-cx

A lightweight client-side script that enables [VTEX CX](https://www.vtex.com/en-us/products/cx_platform) features on VTEX storefronts — compatible with both VTEX IO and FastStore architectures.

The script is publicly served at:

```
https://cdn.cloud.weni.ai/agentic-cx.js
```

## Features

- **Abandoned cart notifications** — tracks the customer's order form and sends notifications to re-engage shoppers who left items in their cart.
- **WebChat** — loads and initializes the VTEX CX WebChat widget for the store, enriched with the current shopper's session and cart context.

## Debugging

To enable verbose logging in the browser console, run the following in the DevTools console:

```js
localStorage.setItem('showWeniPixelLogs', 'true')
```

Logs are prefixed with `[Gist Pixel Script - <timestamp>]`.

## Release workflow

Every push to the `main` branch triggers the [CI/CD workflow](.github/workflows/create-build-and-release.yaml), which:

1. Determines the version bump type — `minor` if any commit message since the last push starts with `feat`, otherwise `patch`.
2. Bumps the version in `package.json` and updates the file header in `main.js`.
3. Creates a git tag and pushes it back to `main`.
4. Uploads `main.js` to the S3 bucket at the path `/agentic-cx.js`.
5. Creates a GitHub Release with auto-generated release notes.

## License

ISC
