// electron-builder.config.js — single source of build config for IronCAD Desktop.
//
// Windows Azure Trusted Signing turns on AUTOMATICALLY only when the
// AZURE_CODE_SIGNING_ACCOUNT env var is present (CI / signed releases). Without it,
// builds are unsigned (fine for internal testing; SmartScreen/Gatekeeper will warn).
// Azure auth creds (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET) are read
// from the environment by the Azure SDK at sign time — never committed.
//
// To enable signed Windows builds, set (CI secrets or local env):
//   AZURE_CODE_SIGNING_ACCOUNT   your Trusted Signing account name
//   AZURE_CODE_SIGNING_PROFILE   your certificate profile name
//   AZURE_CODE_SIGNING_ENDPOINT  region endpoint (default https://eus.codesigning.azure.net/)
//   AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET   service-principal creds
// macOS signing/notarization is driven by CSC_LINK/CSC_KEY_PASSWORD/APPLE_* (see SIGNING.md).

const azureEnabled = !!process.env.AZURE_CODE_SIGNING_ACCOUNT;

const win = {
  target: ["nsis", "portable"],
  icon: "assets/icon.ico",
  signingHashAlgorithms: ["sha256"],
};

if (azureEnabled) {
  win.azureSignOptions = {
    endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT || "https://eus.codesigning.azure.net/",
    codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
    certificateProfileName: process.env.AZURE_CODE_SIGNING_PROFILE,
  };
}

module.exports = {
  appId: "com.ironclad.thor.ironcad",
  productName: "IronCAD",
  files: ["src/**/*", "assets/**/*"],
  win,
  mac: {
    target: ["dmg", "zip"],
    icon: "assets/icon.icns",
    category: "public.app-category.utilities",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    notarize: true,
  },
  dmg: { sign: false },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  publish: [{ provider: "generic", url: "https://ironcad.tech/updates/ironcad-desktop" }],
  protocols: [{ name: "IronCAD", schemes: ["ironcad"] }],
};
