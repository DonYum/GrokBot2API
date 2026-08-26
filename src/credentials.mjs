import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { AppError } from "./errors.mjs";

const MAC_SECRETS_PATH = path.join(os.homedir(), "Library/Application Support/Grok Bot/sand-secrets.json");

export function createCredentialProvider(env = process.env) {
  return {
    async get() {
      const credentials = loadCredentials(env);
      validateCredentials(credentials);
      return credentials;
    }
  };
}

export function loadCredentials(env = process.env) {
  if (env.GROKBOT_ACCESS_TOKEN && env.GROKBOT_MACHINE_ID) {
    return {
      source: "env",
      accessToken: env.GROKBOT_ACCESS_TOKEN,
      machineId: env.GROKBOT_MACHINE_ID,
      clientVersion: env.GROKBOT_CLIENT_VERSION || "0.27.0"
    };
  }
  if (env.GROKBOT_CREDENTIALS_FILE) {
    const parsed = JSON.parse(fs.readFileSync(env.GROKBOT_CREDENTIALS_FILE, "utf8"));
    return {
      source: "file",
      accessToken: stringField(parsed, "accessToken"),
      machineId: stringField(parsed, "machineId"),
      clientVersion: stringField(parsed, "clientVersion") || env.GROKBOT_CLIENT_VERSION || "0.27.0"
    };
  }
  if (env.GROKBOT_CREDENTIALS_COMMAND) return loadCommandCredentials(env);
  if (process.platform === "darwin") return loadMacSafeStorage(env);
  throw new AppError("credentials_not_configured", "Grok Bot credentials are not configured for this host", 503);
}

function loadCommandCredentials(env = process.env) {
  const command = env.GROKBOT_CREDENTIALS_COMMAND;
  if (!path.isAbsolute(command)) {
    throw new AppError("credentials_command_not_absolute", "GROKBOT_CREDENTIALS_COMMAND must be an absolute path", 503);
  }
  const result = spawnSync(command, [], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: positiveInteger(env.GROKBOT_CREDENTIALS_COMMAND_TIMEOUT_MS, 5000),
    maxBuffer: 64 * 1024
  });
  if (result.error) {
    const code = result.error.code === "ETIMEDOUT" ? "credentials_command_timeout" : "credentials_command_failed";
    throw new AppError(code, "Grok Bot credential command failed", 503);
  }
  if (result.status !== 0) {
    throw new AppError("credentials_command_failed", "Grok Bot credential command failed", 503);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    throw new AppError("credentials_command_invalid_output", "Grok Bot credential command returned invalid JSON", 503);
  }
  return {
    source: "command",
    accessToken: stringField(parsed, "accessToken"),
    machineId: stringField(parsed, "machineId"),
    clientVersion: stringField(parsed, "clientVersion") || env.GROKBOT_CLIENT_VERSION || "0.27.0"
  };
}

function loadMacSafeStorage(env = process.env) {
  const keychain = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-w", "-s", "Grok Bot Safe Storage"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, maxBuffer: 64 * 1024 }
  );
  if (keychain.status !== 0 || !keychain.stdout) throw new AppError("keychain_read_failed", "Could not read Grok Bot Safe Storage", 503);
  const store = JSON.parse(fs.readFileSync(env.GROKBOT_MAC_SECRETS_PATH || MAC_SECRETS_PATH, "utf8"));
  const accounts = JSON.parse(store["cursor-accounts"] || "{}");
  const account = accounts.accounts?.[accounts.active];
  if (!account) throw new AppError("no_active_cursor_account", "No active Grok Bot account found", 503);
  return {
    source: "mac_safe_storage",
    accessToken: decryptSafeStorage(account["cursor-access-token"], keychain.stdout.trimEnd()),
    machineId: decryptSafeStorage(store["cursor-machine-id"], keychain.stdout.trimEnd()),
    clientVersion: env.GROKBOT_CLIENT_VERSION || "0.24.0"
  };
}

export function validateCredentials(credentials, now = Date.now()) {
  if (!credentials.accessToken || credentials.accessToken.split(".").length !== 3) {
    throw new AppError("access_token_invalid", "Grok Bot access token is missing or invalid", 503);
  }
  if (!credentials.machineId || credentials.machineId.length < 16) {
    throw new AppError("machine_id_invalid", "Grok Bot machine id is missing or invalid", 503);
  }
  const payload = jwtPayload(credentials.accessToken);
  if (typeof payload.exp === "number" && payload.exp * 1000 - now < 5 * 60_000) {
    throw new AppError("access_token_needs_refresh", "Grok Bot access token needs refresh", 503);
  }
}

export function cursorChecksum(machineId, now = Date.now()) {
  const timestamp = BigInt(Math.floor(now / 1_000_000));
  const bytes = Buffer.from([
    Number((timestamp >> 40n) & 255n),
    Number((timestamp >> 32n) & 255n),
    Number((timestamp >> 24n) & 255n),
    Number((timestamp >> 16n) & 255n),
    Number((timestamp >> 8n) & 255n),
    Number(timestamp & 255n)
  ]);
  let previous = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = ((bytes[index] ^ previous) + (index % 256)) & 255;
    previous = bytes[index];
  }
  return `${bytes.toString("base64url")}${machineId}`;
}

function decryptSafeStorage(ciphertextBase64, password) {
  const encrypted = Buffer.from(ciphertextBase64 || "", "base64");
  if (encrypted.subarray(0, 3).toString("ascii") !== "v10") throw new AppError("unsupported_safe_storage_format", "Unsupported Safe Storage format", 503);
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString("utf8");
}

export function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function stringField(record, key) {
  return typeof record?.[key] === "string" ? record[key] : "";
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
