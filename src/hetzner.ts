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

interface ServerType {
  id: number;
  name: string;
  cores: number;
  memory: number; // in GB
  disk: number; // in GB
  cpu_type: string; // "shared" | "dedicated"
  prices: Price[];
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

interface Datacenter {
  id: number;
  name: string;
  location: {
    id: number;
    name: string;
  };
  server_types: {
    supported: number[];
    available: number[];
    available_for_migration: number[];
  };
}

interface DatacentersResponse {
  datacenters: Datacenter[];
}

/**
 * Thin wrapper around the official Hetzner Cloud REST API.
 *
 * Availability strategy (no resources are ever created):
 * The `/datacenters` endpoint exposes, for every datacenter, which server
 * types are currently `available`. We resolve the server type name (e.g.
 * "cx33") to its numeric id via `/server_types`, then inspect the
 * `available` list of every datacenter belonging to the requested locations.
 * This is the official, side-effect-free way to determine availability.
 */
/** Maps each requested server type name to its available locations. */
export type AvailabilityMap = Map<string, string[]>;

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
   * Resolves and caches the requested server types (id + specs + prices).
   * Throws if any requested name is unknown.
   */
  private async resolveServerTypes(
    serverTypeNames: string[],
  ): Promise<Map<string, ServerType>> {
    if (this.cachedServerTypes === null) {
      try {
        const { data } = await this.http.get<ServerTypesResponse>(
          '/server_types',
          { params: { per_page: 100 } },
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
      const known = Array.from(this.cachedServerTypes.keys()).sort().join(', ');
      throw new HetznerApiError(
        `Unknown server type(s): ${unknown.join(', ')}. Known types: ${known}`,
      );
    }

    return result;
  }

  /**
   * Returns human-friendly specs (cores, memory, disk, per-location prices)
   * for a server type. Only valid after an availability check has populated
   * the cache; returns null otherwise or for unknown names.
   */
  getSpec(serverTypeName: string): ServerTypeSpec | null {
    const type = this.cachedServerTypes?.get(serverTypeName.toLowerCase());
    if (!type) {
      return null;
    }

    const priceByLocation = new Map<
      string,
      { hourlyGross: number; monthlyGross: number }
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
   * For every requested server type, returns the subset of `locations` where
   * it is currently available for creation. A single `/datacenters` request
   * is used regardless of how many server types are checked.
   */
  async getAvailability(
    serverTypeNames: string[],
    locations: string[],
  ): Promise<AvailabilityMap> {
    const typeByName = await this.resolveServerTypes(serverTypeNames);
    const idByName = new Map<string, number>();
    for (const [name, type] of typeByName) {
      idByName.set(name, type.id);
    }
    const wanted = new Set(locations.map((location) => location.toLowerCase()));

    try {
      const { data } = await this.http.get<DatacentersResponse>(
        '/datacenters',
        { params: { per_page: 100 } },
      );

      // For each server type id, collect the set of locations where available.
      const availableByName = new Map<string, Set<string>>();
      for (const name of serverTypeNames) {
        availableByName.set(name.toLowerCase(), new Set<string>());
      }

      for (const datacenter of data.datacenters) {
        const locationName = datacenter.location.name.toLowerCase();
        if (!wanted.has(locationName)) {
          continue;
        }
        for (const [name, id] of idByName) {
          if (datacenter.server_types.available.includes(id)) {
            availableByName.get(name)?.add(locationName);
          }
        }
      }

      // Build the result preserving caller ordering for both dimensions.
      const result: AvailabilityMap = new Map();
      for (const name of serverTypeNames) {
        const availableSet = availableByName.get(name.toLowerCase()) ?? new Set();
        result.set(
          name.toLowerCase(),
          locations.filter((location) => availableSet.has(location.toLowerCase())),
        );
      }
      return result;
    } catch (error) {
      throw this.toApiError(error);
    }
  }

  /**
   * Converts arbitrary errors (Axios/network/HTTP) into a HetznerApiError
   * with a clear, printable message.
   */
  private toApiError(error: unknown): HetznerApiError {
    if (error instanceof HetznerApiError) {
      return error;
    }

    if (isAxiosError(error)) {
      if (error.response) {
        const status = error.response.status;
        const apiError = (error.response.data as { error?: { message?: string; code?: string } })
          ?.error;
        const detail = apiError?.message ?? error.message;
        const code = apiError?.code ? ` (code: ${apiError.code})` : '';

        if (status === 401 || status === 403) {
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

      if (error.code === 'ECONNABORTED') {
        return new HetznerApiError('Request to Hetzner API timed out.');
      }

      return new HetznerApiError(`Network error talking to Hetzner API: ${error.message}.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    return new HetznerApiError(`Unexpected error: ${message}.`);
  }
}
