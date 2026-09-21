import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Repo root, i.e. the parent of server/. */
const ROOT = resolve(import.meta.dirname, "..", "..");

/** Where local state lives. Gitignored; never commit it. */
export const DATA_DIR = process.env.FITBIT_LAB_DATA_DIR ?? join(ROOT, "data");

export const DB_PATH = join(DATA_DIR, "health.db");

/**
 * OAuth client secret downloaded from the Google Cloud console. Kept out of
 * DATA_DIR so that wiping local data does not force a re-download.
 */
export const CLIENT_SECRET_PATH =
  process.env.FITBIT_LAB_CLIENT_SECRET ?? join(ROOT, "client_secret.json");

export const TOKENS_PATH =
  process.env.FITBIT_LAB_TOKENS ?? join(homedir(), ".config", "fitbit-lab", "tokens.json");

export const API_BASE_URL = process.env.FITBIT_LAB_API_BASE ?? "https://health.googleapis.com/v4";

export const SERVER_PORT = Number(process.env.FITBIT_LAB_PORT ?? 8787);
