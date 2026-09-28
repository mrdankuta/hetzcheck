import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, AppConfig } from './config';
import { HetznerClient, HetznerApiError, ServerTypeSpec } from './hetzner';
import { Notifier } from './notifier';
import { logger, formatTimestamp } from './logger';

/**
 * Builds human-readable spec lines (CPU / RAM / SSD / price) for a server
 * type at a given location. Price is location-specific; falls back gracefully
 * if any piece is missing.
 */
function buildSpecLines(
  spec: ServerTypeSpec | null,
  location: string,
): string[] {
  if (!spec) {
    return [];
  }

  const lines = [
    `CPU: ${spec.cores} vCPU (${spec.cpuType})`,
    `RAM: ${spec.memoryGb} GB`,
    `SSD: ${spec.diskGb} GB`,
  ];

  const price = spec.priceByLocation.get(location.toLowerCase());
  if (price) {
    lines.push(
      `Price: €${price.monthlyGross.toFixed(2)}/mo (€${price.hourlyGross.toFixed(4)}/h)`,
    );
  }

  return lines;
}

/** Tracks, per server type, whether it was available on the last check. */
type AvailabilityState = Map<string, boolean>;

/**
 * State keys for "already provisioned" flags. Stored in the same map/file
 * as availability so a single STATE_FILE covers both. Availability keys are
 * bare type names ("cx33"); provisioned keys are namespaced and can never
 * collide with a real server type.
 */
function provisionedKey(serverType: string): string {
  return `provisioned:${serverType.toLowerCase()}`;
}

function isProvisioned(state: AvailabilityState, serverType: string): boolean {
  return state.get(provisionedKey(serverType)) === true;
}

function markProvisioned(state: AvailabilityState, serverType: string): void {
  state.set(provisionedKey(serverType), true);
}

/**
 * Builds the deterministic server name for a type: "<prefix><type>".
 * Sanitized to Hetzner-safe hostname characters so the same input always
 * yields the same name — the name doubles as the idempotency key for the
 * remote existence check.
 */
export function buildServerName(prefix: string, serverType: string): string {
  const raw = `${prefix}${serverType}`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
  const collapsed = raw.replace(/-+/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return (collapsed === '' ? 'hetzcheck-server' : collapsed).slice(0, 63);
}

/**
 * Loads persisted availability state from disk. Used to keep the "notify once"
 * behavior working across separate process runs (e.g. GitHub Actions cron).
 * Missing/unreadable files simply yield an empty state.
 */
function loadState(stateFile: string | null): AvailabilityState {
  const state: AvailabilityState = new Map();
  if (!stateFile) {
    return state;
  }
  try {
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      for (const [key, value] of Object.entries(parsed)) {
        state.set(key, Boolean(value));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not read state file "${stateFile}": ${message}. Starting fresh.`);
  }
  return state;
}

/** Persists availability state to disk (best-effort). */
function saveState(stateFile: string | null, state: AvailabilityState): void {
  if (!stateFile) {
    return;
  }
  try {
    const dir = path.dirname(stateFile);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj: Record<string, boolean> = {};
    for (const [key, value] of state) {
      obj[key] = value;
    }
    fs.writeFileSync(stateFile, JSON.stringify(obj, null, 2), 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Could not write state file "${stateFile}": ${message}.`);
  }
}

/**
 * Attempts to provision a server for one type that is currently available.
 * Runs at most once per type: the local `provisioned:<type>` flag is
 * authoritative (strict "just once" — even if the server is later deleted,
 * we never recreate unless the state file is cleared), while a remote
 * `GET /servers?name=` check guards against duplicates when the state file
 * was lost (e.g. Actions cache miss). Failures leave the flag unset so the
 * next 60s cycle retries. Other server types are unaffected.
 */
async function maybeProvision(
  config: AppConfig,
  client: HetznerClient,
  notifier: Notifier,
  state: AvailabilityState,
  serverType: string,
  availableLocations: string[],
  when: string,
): Promise<void> {
  if (!config.provision.enabled) {
    return;
  }
  if (availableLocations.length === 0) {
    return;
  }
  if (isProvisioned(state, serverType)) {
    logger.info(
      `${serverType.toUpperCase()} already provisioned earlier, skipping (still monitoring other types).`,
    );
    return;
  }

  // Target comes from SERVER_TYPES/LOCATIONS: first available location in
  // the user's priority order.
  const primaryLocation = availableLocations[0];
  const serverName = buildServerName(config.provision.namePrefix, serverType);
  const spec = client.getSpec(serverType);
  const specLines = buildSpecLines(spec, primaryLocation);

  if (config.provision.dryRun) {
    logger.warn(
      `[DRY RUN] Would provision ${serverType.toUpperCase()} in ${primaryLocation} ` +
        `as "${serverName}" (image=${config.provision.image}, ` +
        `ssh_keys=[${config.provision.sshKeys.join(', ') || 'none'}]). ` +
        `No server created.`,
    );
    return;
  }

  if (config.provision.sshKeys.length === 0) {
    logger.warn(
      `PROVISION_SSH_KEYS is empty — creating "${serverName}" without an SSH key. ` +
        `Make sure you can still access it (Hetzner console).`,
    );
  }

  try {
    logger.info(
      `Provisioning ${serverType.toUpperCase()} in ${primaryLocation} as "${serverName}"...`,
    );

    const existing = await client.findServerByName(serverName);
    if (existing) {
      logger.warn(
        `Server "${serverName}" already exists (id=${existing.id}). ` +
          `Marking ${serverType.toUpperCase()} as provisioned without creating a duplicate.`,
      );
      markProvisioned(state, serverType);
      return;
    }

    const created = await client.createServer({
      name: serverName,
      serverType: serverType.toLowerCase(),
      image: config.provision.image,
      location: primaryLocation.toLowerCase(),
      sshKeys: config.provision.sshKeys,
    });

    logger.info(
      `Provisioned ${serverType.toUpperCase()} as "${created.name}" ` +
        `(id=${created.id}, ip=${created.ipv4 ?? 'pending'}) in ${primaryLocation}.`,
    );
    markProvisioned(state, serverType);
    await notifier.notifyProvisioned(
      serverType,
      primaryLocation,
      created.name,
      created.ipv4,
      when,
      specLines,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Duplicate-name race between check and create: treat as done so we
    // don't loop creating servers every cycle.
    if (/uniqueness|already exists|already_taken|name.*taken/i.test(message)) {
      logger.warn(
        `Provisioning reported duplicate name for "${serverName}". ` +
          `Marking as provisioned to avoid a retry loop: ${message}`,
      );
      markProvisioned(state, serverType);
      return;
    }
    if (/401|403|permission|invalid.*token/i.test(message)) {
      logger.error(
        `Provisioning failed (auth/permission): ${message}. ` +
          `Provisioning needs a Read & Write API token (monitoring alone works with Read-only).`,
      );
    } else {
      logger.error(
        `Provisioning failed for ${serverType.toUpperCase()} in ${primaryLocation}: ` +
          `${message}. Will retry on the next check.`,
      );
    }
    // Leave the provisioned flag unset so the next cycle retries.
  }
}

/**
 * Runs a single availability check for all configured server types and reacts
 * to the results. The `state` map (server type -> wasAvailable) is mutated in
 * place so that each Telegram notification is sent only once per availability
 * "episode", independently per server type. Provisioning flags
 * ("provisioned:<type>") live in the same map so they survive Actions
 * handoffs via STATE_FILE.
 */
async function runCheck(
  config: AppConfig,
  client: HetznerClient,
  notifier: Notifier,
  state: AvailabilityState,
): Promise<void> {
  const when = formatTimestamp();
  logger.info(
    `Checking [${config.serverTypes.join(', ')}] in [${config.locations.join(', ')}]...`,
  );

  try {
    const availability = await client.getAvailability(
      config.serverTypes,
      config.locations,
    );

    for (const serverType of config.serverTypes) {
      const key = serverType.toLowerCase();
      const availableLocations = availability.get(key) ?? [];
      const wasAvailable = state.get(key) ?? false;

      if (availableLocations.length > 0) {
        const spec = client.getSpec(serverType);

        // Big green banner for every check while it stays available.
        for (const location of availableLocations) {
          logger.availableBanner(
            serverType,
            location,
            when,
            buildSpecLines(spec, location),
          );
        }

        // Telegram: send once per availability "episode" per server type.
        if (!wasAvailable) {
          const primaryLocation = availableLocations[0];
          if (notifier.isEnabled) {
            logger.info(`Sending Telegram notification for ${serverType.toUpperCase()}...`);
          } else {
            logger.warn(
              `${serverType.toUpperCase()} is available but Telegram is disabled ` +
                `(TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set). No message sent.`,
            );
          }
          await notifier.notifyAvailable(
            serverType,
            primaryLocation,
            when,
            buildSpecLines(spec, primaryLocation),
          );
        } else {
          logger.info(
            `${serverType.toUpperCase()} still available in [${availableLocations.join(', ')}] ` +
              `(already notified earlier, skipping Telegram).`,
          );
        }

        state.set(key, true);

        // Auto-provision (once per type, first available location in
        // LOCATIONS order). Never blocks monitoring of other types.
        await maybeProvision(
          config,
          client,
          notifier,
          state,
          serverType,
          availableLocations,
          when,
        );
      } else {
        logger.info(`${serverType.toUpperCase()} unavailable`);
        // Reset state so the next transition to "available" notifies again.
        state.set(key, false);
      }
    }
  } catch (error) {
    if (error instanceof HetznerApiError) {
      logger.error(error.message);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Unexpected error during check: ${message}`);
    }
    // On error, leave the previous availability state untouched.
  }
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    process.exitCode = 1;
    return;
  }

  const client = new HetznerClient(config.apiToken);
  const notifier = new Notifier(config.telegram);
  const state = loadState(config.stateFile);

  const provisionNote = config.provision.enabled
    ? `Provisioning: enabled (image=${config.provision.image}, ` +
      `prefix="${config.provision.namePrefix}"` +
      `${config.provision.dryRun ? ', DRY RUN' : ''}).`
    : 'Provisioning: disabled.';

  // Single-check mode: run once, persist state, and exit. Designed for
  // scheduled runners such as GitHub Actions cron.
  if (config.runOnce) {
    logger.info(
      `Running a single check. ` +
        `Telegram: ${notifier.isEnabled ? 'enabled' : 'disabled'}. ` +
        provisionNote,
    );
    await runCheck(config, client, notifier, state);
    saveState(config.stateFile, state);
    return;
  }

  const maxRuntimeNote =
    config.maxRuntimeMs > 0
      ? ` Max runtime: ${config.maxRuntimeMs / 1000}s.`
      : '';
  logger.info(
    `Started Hetzner availability monitor. ` +
      `Interval: ${config.checkIntervalMs / 1000}s.${maxRuntimeNote} ` +
      `Telegram: ${notifier.isEnabled ? 'enabled' : 'disabled'}. ` +
      provisionNote,
  );

  const startedAt = Date.now();
  let running = true;

  const stop = (reason: string, exitCode: number): void => {
    if (!running) {
      return;
    }
    running = false;
    logger.warn(`${reason} Shutting down...`);
    saveState(config.stateFile, state);
    process.exit(exitCode);
  };

  process.on('SIGINT', () => stop('Received SIGINT.', 0));
  process.on('SIGTERM', () => stop('Received SIGTERM.', 0));

  // Recursive scheduling guarantees checks never overlap, even if a single
  // check takes longer than the interval.
  const scheduleNext = (): void => {
    if (!running) {
      return;
    }
    // Stop cleanly before hitting an external time limit (e.g. CI job cap).
    if (config.maxRuntimeMs > 0 && Date.now() - startedAt >= config.maxRuntimeMs) {
      stop('Reached max runtime.', 0);
      return;
    }
    setTimeout(async () => {
      await runCheck(config, client, notifier, state);
      saveState(config.stateFile, state);
      scheduleNext();
    }, config.checkIntervalMs);
  };

  // Run the first check immediately, then schedule the recurring loop.
  await runCheck(config, client, notifier, state);
  saveState(config.stateFile, state);
  scheduleNext();
}

void main();
