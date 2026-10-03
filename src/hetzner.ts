import axios, { AxiosInstance, isAxiosError } from 'axios';

const HETZNER_API_BASE_URL = 'https://api.hetzner.cloud/v1';

/**
 * Error thrown for any problem while talking to the Hetzner Cloud API.
 * Carries a human-readable message that is safe to print/log.
 */
export class HetznerApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HetznerApiError';
  }
}

interface Price {
  location: string;
  price_hourly: { net: string; gross: string };
  price_monthly: { net: string; gross: string };
}

/**
 * Availability is now exposed directly on each server type per location.
 *
 * Hetzner deprecated the old datacenter.server_types availability fields
 * and removed GET /v1/datacenters after 1 October 2026.
 */
interface ServerTypeLocation {
  id: number;
  name: string;
  available: boolean;
  recommended: boolean;
}

interface ServerType {
  id: number;
  name: string;
  cores: number;
  memory: number; // in GB
  disk: number; // in GB
  cpu_type: string; // "shared" | "dedicated"
  prices: Price[];
  locations: ServerTypeLocation[];
}

interface ServerTypesResponse {
  server_types: ServerType[];
}

/** Human-friendly, currency-aware specs for a server type. */
export interface ServerTypeSpec {
  name: string;
  cores: number;
  cpuType: string;
  memoryGb: number;
  diskGb: number;
  /** Gross prices (EUR) per location name. */
  priceByLocation: Map<string, { hourlyGross: number; monthlyGross: number }>;
}

/**
 * Thin wrapper around the official Hetzner Cloud REST API.
 *
 * Availability strategy (no resources are ever created):
 *
 * Hetzner exposes availability directly on every Server Type through
 * `server_type.locations[].available`.
 *
 * The old `/datacenters` endpoint and
 * `datacenter.server_types.available` fields were deprecated and removed
 * after 1 October 2026.
 *
 * We therefore fetch `/server_types`, resolve the requested types by name,
 * and inspect their per-location availability flags.
 */

/** Maps each requested server type name to its available locations. */
export type AvailabilityMap = Map<string, string[]>;

/** Parameters for creating a server via POST /servers. */
export interface CreateServerParams {
  name: string;
  serverType: string;
  image: string;
  location: string;
  sshKeys: string[];
}

/** Minimal info about an existing or newly created server. */
export interface ServerInfo {
  id: number;
  name: string;
  ipv4: string | null;
  ipv6: string | null;
  status: string | null;
}

interface HetznerServer {
  id: number;
  name: string;
  status?: string;
  public_net?: {
    ipv4?: { ip?: string };
    ipv6?: { ip?: string };
  };
}

interface ServersResponse {
  servers: HetznerServer[];
}

interface CreateServerResponse {
  server: HetznerServer;
}

export class HetznerClient {
  private readonly http: AxiosInstance;

  /** Cache of server type name (lowercase) -> full server type object. */
  private cachedServerTypes: Map<string, ServerType> | null = null;

  constructor(apiToken: string) {
    this.http = axios.create({
      baseURL: HETZNER_API_BASE_URL,
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Resolves and caches the requested server types
   * (availability + specs + prices).
   *
   * Throws if any requested name is unknown.
   */
  private async resolveServerTypes(
    serverTypeNames: string[],
  ): Promise<Map<string, ServerType>> {
    if (this.cachedServerTypes === null) {
      try {
        const { data } = await this.http.get<ServerTypesResponse>(
          '/server_types',
          {
            params: {
              per_page: 100,
            },
          },
        );

        const map = new Map<string, ServerType>();

        for (const type of data.server_types) {
          map.set(type.name.toLowerCase(), type);
        }

        this.cachedServerTypes = map;
      } catch (error) {
        throw this.toApiError(error);
      }
    }

    const result = new Map<string, ServerType>();
    const unknown: string[] = [];

    for (const name of serverTypeNames) {
      const type = this.cachedServerTypes.get(name.toLowerCase());

      if (type === undefined) {
        unknown.push(name);
      } else {
        result.set(name.toLowerCase(), type);
      }
    }

    if (unknown.length > 0) {
      const known = Array.from(this.cachedServerTypes.keys())
        .sort()
        .join(', ');

      throw new HetznerApiError(
        `Unknown server type(s): ${unknown.join(', ')}. Known types: ${known}`,
      );
    }

    return result;
  }

  /**
   * Returns human-friendly specs (cores, memory, disk, per-location prices)
   * for a server type.
   *
   * Only valid after an availability check has populated the cache;
   * returns null otherwise or for unknown names.
   */
  getSpec(serverTypeName: string): ServerTypeSpec | null {
    const type = this.cachedServerTypes?.get(
      serverTypeName.toLowerCase(),
    );

    if (!type) {
      return null;
    }

    const priceByLocation = new Map<
      string,
      {
        hourlyGross: number;
        monthlyGross: number;
      }
    >();

    for (const price of type.prices) {
      priceByLocation.set(price.location.toLowerCase(), {
        hourlyGross: Number.parseFloat(price.price_hourly.gross),
        monthlyGross: Number.parseFloat(price.price_monthly.gross),
      });
    }

    return {
      name: type.name,
      cores: type.cores,
      cpuType: type.cpu_type,
      memoryGb: type.memory,
      diskGb: type.disk,
      priceByLocation,
    };
  }

  /**
   * For every requested server type, returns the subset of requested
   * locations where that server type is currently available for creation.
   *
   * Availability is read from:
   *
   *   GET /server_types
   *   server_type.locations[].available
   *
   * No `/datacenters` request is required.
   *
   * Because resolveServerTypes() caches the complete `/server_types`
   * response, checking multiple server types does not require one API call
   * per type.
   */
  async getAvailability(
    serverTypeNames: string[],
    locations: string[],
  ): Promise<AvailabilityMap> {
    const typeByName = await this.resolveServerTypes(serverTypeNames);

    const wantedLocations = new Set(
      locations.map((location) => location.toLowerCase()),
    );

    const result: AvailabilityMap = new Map();

    for (const serverTypeName of serverTypeNames) {
      const key = serverTypeName.toLowerCase();
      const type = typeByName.get(key);

      if (!type) {
        result.set(key, []);
        continue;
      }

      const availableLocations = new Set<string>();

      for (const location of type.locations ?? []) {
        const locationName = location.name.toLowerCase();

        if (
          location.available === true &&
          wantedLocations.has(locationName)
        ) {
          availableLocations.add(locationName);
        }
      }

      /*
       * Preserve the location priority/order supplied by the user.
       *
       * Example:
       *
       * LOCATIONS=fsn1,nbg1,hel1
       *
       * If nbg1 and hel1 are available, this returns:
       *
       * ["nbg1", "hel1"]
       */
      result.set(
        key,
        locations.filter((location) =>
          availableLocations.has(location.toLowerCase()),
        ),
      );
    }

    return result;
  }

  /**
   * Looks up a server by exact name.
   *
   * Returns null when no such server exists.
   *
   * Used as the remote idempotency guard before creating:
   * the persisted state file (Actions cache) is best-effort and may
   * be lost, but the Hetzner API is the source of truth for
   * "did we already provision?".
   */
  async findServerByName(
    name: string,
  ): Promise<ServerInfo | null> {
    try {
      const { data } = await this.http.get<ServersResponse>(
        '/servers',
        {
          params: {
            name,
            per_page: 1,
          },
        },
      );

      const match =
        data.servers.find(
          (server) => server.name === name,
        ) ?? null;

      return match
        ? this.toServerInfo(match)
        : null;
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  /**
   * Creates a server via POST /servers.
   *
   * Resolves with the new server's id and public IPs.
   *
   * Throws HetznerApiError on failure — the caller decides whether
   * to retry (e.g. sold out between check and create) or mark as done
   * (e.g. name already exists).
   */
  async createServer(
    params: CreateServerParams,
  ): Promise<ServerInfo> {
    try {
      const { data } =
        await this.http.post<CreateServerResponse>(
          '/servers',
          {
            name: params.name,
            server_type: params.serverType,
            image: params.image,
            location: params.location,
            ssh_keys: params.sshKeys,
            start_after_create: true,
            labels: {
              'managed-by': 'hetzcheck',
            },
          },
        );

      return this.toServerInfo(data.server);
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  private toServerInfo(
    server: HetznerServer,
  ): ServerInfo {
    return {
      id: server.id,
      name: server.name,
      ipv4:
        server.public_net?.ipv4?.ip ??
        null,
      ipv6:
        server.public_net?.ipv6?.ip ??
        null,
      status:
        server.status ??
        null,
    };
  }

  /**
   * Converts arbitrary errors (Axios/network/HTTP)
   * into a HetznerApiError with a clear, printable message.
   */
  private toApiError(
    error: unknown,
  ): HetznerApiError {
    if (error instanceof HetznerApiError) {
      return error;
    }

    if (isAxiosError(error)) {
      if (error.response) {
        const status =
          error.response.status;

        const apiError = (
          error.response.data as {
            error?: {
              message?: string;
              code?: string;
            };
          }
        )?.error;

        const detail =
          apiError?.message ??
          error.message;

        const code =
          apiError?.code
            ? ` (code: ${apiError.code})`
            : '';

        if (
          status === 401 ||
          status === 403
        ) {
          return new HetznerApiError(
            `Authentication failed (HTTP ${status})${code}: ${detail}. ` +
              `Check that API_TOKEN is valid.`,
          );
        }

        if (status === 429) {
          return new HetznerApiError(
            `Rate limited by Hetzner API (HTTP 429)${code}: ${detail}.`,
          );
        }

        return new HetznerApiError(
          `Hetzner API error (HTTP ${status})${code}: ${detail}.`,
        );
      }

      if (
        error.code === 'ECONNABORTED'
      ) {
        return new HetznerApiError(
          'Request to Hetzner API timed out.',
        );
      }

      return new HetznerApiError(
        `Network error talking to Hetzner API: ${error.message}.`,
      );
    }

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return new HetznerApiError(
      `Unexpected error: ${message}.`,
    );
  }
}
