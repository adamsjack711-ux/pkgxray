"use strict";

// Centralized high-confidence local secret paths. Keeping the catalog separate
// from verdict policy makes additions reviewable and lets every runtime surface
// consume the same boundary-aware expressions.
const SUSPICIOUS_READ_TARGETS = [
  { re: /['"`\/\\]\.?ssh\/(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys)/i, label: "ssh-private-key" },
  { re: /['"`\/\\]id_(?:rsa|dsa|ecdsa|ed25519)\b/i, label: "ssh-key-file" },
  { re: /['"`\/\\]\.ssh(?:\/|['"`])/, label: ".ssh-dir" },
  { re: /['"`\/\\]\.aws\/credentials\b/, label: ".aws/credentials" },
  { re: /['"`\/\\]\.aws\/(?:config|credentials)\b/, label: ".aws-files" },
  { re: /['"`\/\\]\.npmrc(?:['"`]|\s|$)/, label: ".npmrc" },
  { re: /['"`\/\\]\.env(?:\.[a-z]+)?(?:['"`]|\s|$)/i, label: ".env-file" },
  { re: /['"`]login\.keychain(?:-db)?['"`]/i, label: "macOS keychain" },
  { re: /\bsecurity\s+find-(?:generic|internet)-password\b/, label: "macOS security CLI" },
  { re: /['"`]\/?(?:Cookies|Login Data|Web Data|cookies\.sqlite)['"`]/i, label: "browser-creds" },
  { re: /['"`]Local State['"`]/, label: "browser local-state" },
  { re: /\bkeytar\.[a-z]+Password\(/i, label: "keytar API" },
  { re: /\bmetamask['"`\s\/]/i, label: "metamask wallet" },
  { re: /\b(?:electrum|exodus|ledger live|atomic wallet)\b/i, label: "crypto wallet" },
  { re: /['"`\/\\]\.ethereum[\/\\]keystore(?:[\/\\]|['"`]|\s|$)/i, label: "Ethereum keystore" },
  { re: /['"`\/\\]\.bitcoin[\/\\](?:wallets?|bitcoin\.conf)(?:[\/\\]|['"`]|\s|$)/i, label: "Bitcoin wallet/config" },
  { re: /['"`\/\\]\.config[\/\\]solana[\/\\](?:id\.json|cli[\/\\]config\.yml)(?:['"`]|\s|$)/i, label: "Solana keypair/config" },
  { re: /['"`\/\\]\.config[\/\\]gcloud[\/\\](?:credentials\.db|application_default_credentials\.json)(?:['"`]|\s|$)/i, label: "Google Cloud credentials" },
  { re: /['"`\/\\]\.azure[\/\\](?:accessTokens\.json|azureProfile\.json|msal_token_cache\.json)(?:['"`]|\s|$)/i, label: "Azure credentials" },
  { re: /['"`\/\\]\.gnupg(?:[\/\\]|['"`])/i, label: "GnuPG keyring" }
];

const AGENT_CONFIG_READ_TARGETS = [
  { re: /['"`\/\\]\.claude\.json(?:['"`]|\s|$)/i, label: "Claude Code config (.claude.json)" },
  { re: /['"`\/\\]\.claude\/(?:settings(?:\.local)?|mcp)\.json/i, label: "Claude Code settings/MCP config" },
  { re: /['"`\/\\]\.kiro\/settings\/mcp\.json/i, label: "Kiro MCP config" },
  { re: /['"`\/\\]\.cursor\/(?:mcp|environment)\.json/i, label: "Cursor MCP/environment config" },
  { re: /['"`\/\\]\.codeium(?:\/|['"`])/i, label: "Codeium/Windsurf config" },
  { re: /['"`\/\\]\.continue\/config\.(?:json|ya?ml)/i, label: "Continue config" },
  { re: /['"`\/\\]\.aider(?:\.conf)?\.ya?ml/i, label: "Aider config" },
  { re: /['"`\/\\]\.config\/github-copilot(?:\/|['"`])/i, label: "GitHub Copilot config" },
  { re: /['"`\/\\]\.codex\/config\.toml/i, label: "Codex config" },
  { re: /['"`\/\\]\.gemini\/(?:settings|mcp)\.json/i, label: "Gemini CLI settings/MCP config" }
];

module.exports = { SUSPICIOUS_READ_TARGETS, AGENT_CONFIG_READ_TARGETS };
