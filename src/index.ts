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
 * Runs a single availability check for all configured server types and reacts
 * to the results. The `state` map (server type -> wasAvailable) is mutated in
 * place so that each Telegram notification is sent only once per availability
 * "episode", independently per server type.
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

  // Single-check mode: run once, persist state, and exit. Designed for
  // scheduled runners such as GitHub Actions cron.
  if (config.runOnce) {
    logger.info(
      `Running a single check. ` +
        `Telegram: ${notifier.isEnabled ? 'enabled' : 'disabled'}.`,
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
      `Telegram: ${notifier.isEnabled ? 'enabled' : 'disabled'}.`,
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
