import "server-only";
import { createDatabaseClient, type DatabaseClient } from "./db/client.ts";
import { parseDatabaseConfig } from "./db/config.ts";
import { DatabaseUnavailableError } from "./db/errors.ts";
import { verifyRuntimeDatabase } from "./db/runtime-check.ts";
import { BootstrapRepository } from "./repositories/bootstrap.ts";
import { SessionRepository } from "./repositories/session.ts";
import { LibraryRepository } from "./repositories/library.ts";
import { DashboardRepository } from "./repositories/dashboard.ts";
import { CollectionsRepository } from "./repositories/collections.ts";
import { WishlistRepository } from "./repositories/wishlist.ts";
import { AuthRepository } from "./repositories/auth.ts";
import { MutationsRepository } from "./repositories/mutations.ts";
import { StoreRepository } from "./repositories/store.ts";
import { CollectionMutationsRepository } from "./repositories/collection-mutations.ts";
import { VaultRepository } from "./repositories/vault.ts";
import { FamilyRepository } from "./repositories/family.ts";
import { ImportRepository } from "./repositories/import.ts";
import { PinnedRepository } from "./repositories/pinned.ts";
import { GuestRepository } from "./repositories/guest.ts";

import { BlogRepository } from "./repositories/blog.ts";
import { WishlistDiscoveryRepository } from "./repositories/wishlist-discovery.ts";

let runtime: ReturnType<typeof createRuntime> | undefined;

/** Explicit V2 configuration; never borrow legacy or operator credentials. */
export function getV2Runtime() {
  if (!runtime) {
    runtime = createRuntime().catch(error => {
      runtime = undefined;
      throw error;
    });
  }
  return runtime;
}

async function createRuntime() {
  let database: DatabaseClient | undefined;
  try {
    database = createDatabaseClient(parseDatabaseConfig({
      connectionString: process.env.V2_DATABASE_URL,
      maxConnections: 2,
      tlsCaPem: process.env.V2_DATABASE_CA_PEM,
    }));
    await verifyRuntimeDatabase(database, process.env.V2_PROJECT_REF ?? "");
    return {
      database,
      sessions: new SessionRepository(database),
      bootstrap: new BootstrapRepository(database),
      library: new LibraryRepository(database),
      dashboard: new DashboardRepository(database),
      collections: new CollectionsRepository(database),
      wishlist: new WishlistRepository(database),
      auth: new AuthRepository(database),
      mutations: new MutationsRepository(database),
      store: new StoreRepository(database),
      collectionMutations: new CollectionMutationsRepository(database),
      vault: new VaultRepository(database),
      family: new FamilyRepository(database),
      imports: new ImportRepository(database),
      pinned: new PinnedRepository(database),
      guest: new GuestRepository(database),
      blog: new BlogRepository(database),
      wishlistDiscovery: new WishlistDiscoveryRepository(database),
    };
  } catch {
    await database?.close().catch(() => {});
    throw new DatabaseUnavailableError();
  }
}
