import type { DatabaseClient } from "./client.ts";
import { DatabaseUnavailableError } from "./errors.ts";

/** Refuse operator credentials and a connection to the wrong project. */
export async function verifyRuntimeDatabase(database: DatabaseClient, expectedProjectRef: string): Promise<void> {
  try {
    if (!/^[a-z]{20}$/.test(expectedProjectRef)) throw new DatabaseUnavailableError();
    const rows = await database.sql<{ safe: boolean }[]>`
      select (
        pg_has_role(current_user, 'vault_app', 'USAGE')
        and not exists (
          select 1 from pg_roles r
          where (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication
            or r.rolname = 'vault_worker'
            or r.oid in (select nspowner from pg_namespace where nspname in ('app','catalog','ops','migration','reco')))
            and (pg_has_role(current_user,r.oid,'USAGE') or pg_has_role(current_user,r.oid,'SET'))
        )
        and exists (select 1 from app.read_project_marker() where expected_project_ref=${expectedProjectRef})
      ) safe
    `;
    if (rows.length !== 1 || rows[0].safe !== true) throw new DatabaseUnavailableError();
  } catch (error) {
    throw new DatabaseUnavailableError(error);
  }
}
