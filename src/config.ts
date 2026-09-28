import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  /** Hetzner Cloud API token. */
  apiToken: string;
  /** Hetzner server type "names" to watch, e.g. ["cx33", "cx23"]. */
  serverTypes: string[];
  /** Location names to check, e.g. ["fsn1", "nbg1", "hel1"]. */
  locations: string[];
  /** Interval between checks, in milliseconds. */
  checkIntervalMs: number;
  /** When true, run a single check and exit (for cron / GitHub Actions). */
  runOnce: boolean;
  /**
   * In loop mode, stop and exit cleanly after this many milliseconds.
   * 0 means "run forever". Used to stay under CI job time limits.
   */
  maxRuntimeMs: number;
  /** Optional path to persist availability state across runs. */
  stateFile: string | null;
  /** Telegram configuration. Enabled only when both fields are present. */
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
  };
  /** Auto-provisioning configuration. Disabled unless explicitly enabled. */
  provision: {
    enabled: boolean;
    /** OS image name, e.g. "ubuntu-24.04". Required when enabled. */
    image: string;
    /** SSH key names (as stored in Hetzner Cloud). May be empty (not recommended). */
    sshKeys: string[];
    /** Prefix for auto-created server names. Final name: "<prefix><type>", e.g. "hetzcheck-cx33". */
    namePrefix: string;
    /** When true, log what would be created without calling POST /servers. */
    dryRun: boolean;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Loads and validates configuration from environment variables.
 * Throws a descriptive error if a required variable is missing.
 */
export function loadConfig(): AppConfig {
  const apiToken = required('API_TOKEN');

  // Accepts a comma-separated list via SERVER_TYPES; falls back to the legacy
  // single-value SERVER_TYPE, then to "cx33". Duplicates are removed.
  const rawServerTypes = optional('SERVER_TYPES', optional('SERVER_TYPE', 'cx33'));
  const serverTypes = Array.from(
    new Set(
      rawServerTypes
        .split(',')
        .map((type) => type.trim().toLowerCase())
        .filter((type) => type.length > 0),
    ),
  );

  if (serverTypes.length === 0) {
    throw new Error('No server types configured. Set SERVER_TYPES in your .env file.');
  }

  const locations = optional('LOCATIONS', 'fsn1,nbg1,hel1')
    .split(',')
    .map((location) => location.trim().toLowerCase())
    .filter((location) => location.length > 0);

  if (locations.length === 0) {
    throw new Error('No locations configured. Set LOCATIONS in your .env file.');
  }

  const intervalSeconds = Number.parseInt(
    optional('CHECK_INTERVAL_SECONDS', '60'),
    10,
  );
  const checkIntervalMs =
    Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds * 1000
      : 60_000;

  const runOnce = optional('RUN_ONCE', 'false').toLowerCase() === 'true';

  const maxRuntimeSeconds = Number.parseInt(
    optional('MAX_RUNTIME_SECONDS', '0'),
    10,
  );
  const maxRuntimeMs =
    Number.isFinite(maxRuntimeSeconds) && maxRuntimeSeconds > 0
      ? maxRuntimeSeconds * 1000
      : 0;

  const stateFileRaw = optional('STATE_FILE', '');
  const stateFile = stateFileRaw !== '' ? stateFileRaw : null;

  const botToken = optional('TELEGRAM_BOT_TOKEN', '');
  const chatId = optional('TELEGRAM_CHAT_ID', '');
  const telegramEnabled = botToken !== '' && chatId !== '';

  const provisionEnabled =
    optional('PROVISION_ENABLED', 'false').toLowerCase() === 'true';
  const provisionImage = optional('PROVISION_IMAGE', '');
  const provisionSshKeys = optional('PROVISION_SSH_KEYS', '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
  const provisionNamePrefix = optional('PROVISION_NAME_PREFIX', 'hetzcheck-');
  const provisionDryRun =
    optional('PROVISION_DRY_RUN', 'false').toLowerCase() === 'true';

  if (provisionEnabled) {
    if (provisionImage === '') {
      throw new Error(
        'PROVISION_ENABLED=true requires PROVISION_IMAGE to be set ' +
          '(e.g. "ubuntu-24.04").',
      );
    }
    if (provisionNamePrefix === '') {
      throw new Error(
        'PROVISION_ENABLED=true requires PROVISION_NAME_PREFIX to be non-empty.',
      );
    }
  }

  return {
    apiToken,
    serverTypes,
    locations,
    checkIntervalMs,
    runOnce,
    maxRuntimeMs,
    stateFile,
    telegram: {
      enabled: telegramEnabled,
      botToken,
      chatId,
    },
    provision: {
      enabled: provisionEnabled,
      image: provisionImage,
      sshKeys: provisionSshKeys,
      namePrefix: provisionNamePrefix,
      dryRun: provisionDryRun,
    },
  };
}
