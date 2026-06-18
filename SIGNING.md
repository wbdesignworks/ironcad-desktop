# IronCAD Desktop — Code Signing & Notarization

The app is **configured** for signed, notarized builds. Signing is driven entirely by
environment variables / CI secrets — **no certificate or password is ever committed**.
Config lives in `electron-builder.config.js` (single source; replaces the old package.json
`build` block). Unsigned builds still work for internal testing; they just trigger
SmartScreen (Windows) / Gatekeeper (macOS) warnings.

## What's already wired
- **Windows — Azure Trusted Signing (configured, electron-builder 25.1.8):** `electron-builder.config.js`
  injects `win.azureSignOptions` **automatically** whenever `AZURE_CODE_SIGNING_ACCOUNT` is set in the
  environment. No hardware token, CI-friendly. Unsigned by default when the env var is absent.
- macOS: `hardenedRuntime: true`, `gatekeeperAssess: false`, `notarize: true`, entitlements in `build/`.
- CI: `.github/workflows/release.yml` builds + signs + notarizes on a `v*` tag (or manual dispatch).

---

## 1. macOS — Developer ID + notarization
**Get (one-time):** Apple Developer Program ($99/yr, supplies Team ID); a **Developer ID Application**
cert exported from Keychain as `.p12` (with password); an **app-specific password** (appleid.apple.com).
**Provide (env / CI secrets):**
| Variable | Value |
|---|---|
| `CSC_LINK` (CI: `MAC_CSC_LINK`) | base64 of the `.p12` — `base64 -i cert.p12` |
| `CSC_KEY_PASSWORD` (CI: `MAC_CSC_KEY_PASSWORD`) | the `.p12` export password |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | 10-char Team ID |
```bash
export CSC_LINK=$(base64 -i DeveloperIDApp.p12) CSC_KEY_PASSWORD=… APPLE_ID=… \
       APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=…
npm ci && npm run build:mac
```

---

## 2. Windows — Azure Trusted Signing (recommended, already configured)
The code config is done. You only need to stand up the Azure resources once and supply env values.

**Stand up (one-time, in the Azure portal — your action, requires an Azure subscription):**
1. Create a **Trusted Signing account** (Azure → "Trusted Signing Accounts"). Note its **account name** and **region endpoint** (e.g. `https://eus.codesigning.azure.net/`).
2. Complete **identity validation** (individual or organization) and create a **Certificate Profile**. Note its **profile name**.
3. Create (or reuse) an **Entra service principal** and grant it the **Trusted Signing Certificate Profile Signer** role on the account. Note `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

**Provide (env locally, or repo Actions secrets):**
| Variable | Value | Secret? |
|---|---|---|
| `AZURE_CODE_SIGNING_ACCOUNT` | Trusted Signing account name | no (identifier) |
| `AZURE_CODE_SIGNING_PROFILE` | certificate profile name | no (identifier) |
| `AZURE_CODE_SIGNING_ENDPOINT` | region endpoint (optional; defaults to `https://eus.codesigning.azure.net/`) | no |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | service-principal creds | **yes** |

```cmd
set AZURE_CODE_SIGNING_ACCOUNT=… & set AZURE_CODE_SIGNING_PROFILE=… ^
 & set AZURE_TENANT_ID=… & set AZURE_CLIENT_ID=… & set AZURE_CLIENT_SECRET=… ^
 & npm ci & npm run build:win
```
With those set, electron-builder signs automatically via Azure Trusted Signing. Unset → unsigned build.

> Legacy `.pfx` path is still supported by electron-builder via `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`
> if you ever use a file-based OV/EV cert instead of Azure. EV clears SmartScreen immediately; Azure
> Trusted Signing builds reputation over time like an OV cert.

---

## 3. CI (recommended)
```bash
git tag v1.0.1 && git push origin v1.0.1   # (set a remote first; this repo has none yet)
```
Add the variables above as **repo Actions secrets** (names per `.github/workflows/release.yml`).
The workflow runs macOS + Windows runners, signs, notarizes (mac), and publishes to the update feed.

## Security
- Never commit `.p12` / `.pfx` / passwords / `AZURE_CLIENT_SECRET`. They live only in env / CI secrets.
- The committed `build/entitlements*.plist` and the `AZURE_CODE_SIGNING_ACCOUNT`/`_PROFILE`/`_ENDPOINT`
  identifiers contain no secrets.
