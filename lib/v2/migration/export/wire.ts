import { Buffer } from "node:buffer";
import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { ExportError, redact } from "../shared/redaction.ts";
import type { Secret } from "../shared/secret.ts";

/**
 * A minimal PostgreSQL frontend/backend protocol v3 client, written for one job:
 * streaming `COPY ... TO STDOUT` out of a single read-only repeatable-read
 * transaction with bounded memory.
 *
 * It exists rather than a dependency or a `psql` child process because all three
 * of the exporter's hard requirements are properties of the transport:
 *
 * - **Exact wire bytes.** The manifest digest has to be taken over the bytes the
 *   server actually sent. A library that decodes rows into JavaScript values and
 *   re-encodes them hashes our reconstruction, not the server's output.
 * - **No credential in process arguments.** `psql` would put the connection
 *   string on a command line or in the environment, where any local process can
 *   read it from `ps`. Here the password is a `Secret` that reaches only the
 *   SCRAM computation.
 * - **TLS we control.** The temporary client at `/tmp/vaultshuffle-pg17` was
 *   built with `USE_OPENSSL` undefined and cannot do TLS at all. Node's own TLS
 *   stack can, with full certificate verification, so no weakened client and no
 *   second libpq build is involved.
 *
 * Protocol reference: PostgreSQL 17 documentation, "Frontend/Backend Protocol"
 * (protocol version 3.0), and RFC 5802/7677 for SCRAM-SHA-256.
 */

const PROTOCOL_VERSION_3 = 196608;
const SSL_REQUEST_CODE = 80877103;
// SCRAM-SHA-256-PLUS (channel binding) is deliberately not implemented. A server
// that offers only the -PLUS variant is reported by name in the mechanism error
// below rather than silently downgraded.
const SCRAM_SHA_256 = "SCRAM-SHA-256";
const SCRAM_ITERATION_CEILING = 100_000;
const EMPTY = Buffer.alloc(0);

export type WireTlsPolicy =
  /** TCP: TLS is mandatory and the certificate chain and hostname are verified. */
  | { kind: "verify-full"; caCertificatesPem?: string }
  /** Unix domain socket: no network hop exists to protect. */
  | { kind: "unix-socket" };

export type WireConnectOptions = {
  /** Hostname for TCP, or a socket *directory* for a Unix domain socket. */
  host: string;
  port: number;
  user: string;
  database: string;
  password: Secret | null;
  tls: WireTlsPolicy;
  applicationName: string;
  connectTimeoutMs: number;
};

export type QueryField = { name: string };

export type QueryResult = {
  fields: readonly QueryField[];
  /** Text-format values exactly as the server rendered them; null stays null. */
  rows: ReadonlyArray<ReadonlyArray<string | null>>;
  commandTag: string;
};

/**
 * Receives `CopyData` payloads in arrival order.
 *
 * Returning `false` means "not drained": the connection stops reading from the
 * socket until `whenDrained` settles. This is the whole of the exporter's memory
 * bound — a relation larger than memory is never held in memory, and a slow disk
 * throttles the server rather than filling a queue.
 */
export type CopySink = {
  write(chunk: Buffer): boolean;
  whenDrained(): Promise<void>;
};

type PendingCommand = {
  resolve: (result: QueryResult) => void;
  reject: (error: unknown) => void;
  fields: QueryField[];
  rows: Array<Array<string | null>>;
  commandTag: string;
  failure: ExportError | null;
  copy: CopySink | null;
};

function frontendMessage(type: string | null, payload: Buffer): Buffer {
  const header = Buffer.alloc(type === null ? 4 : 5);
  let offset = 0;
  if (type !== null) {
    header.write(type, 0, "latin1");
    offset = 1;
  }
  header.writeInt32BE(payload.length + 4, offset);
  return Buffer.concat([header, payload]);
}

function cStrings(pairs: ReadonlyArray<readonly [string, string]>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of pairs) {
    parts.push(Buffer.from(`${key}\0${value}\0`, "utf8"));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/**
 * The SQLSTATE values this exporter is willing to repeat.
 *
 * Dropping the server's text is not on its own enough. `RAISE ... USING
 * ERRCODE` lets a function choose its own five-character SQLSTATE, so an
 * unfiltered code is still five characters of server-chosen data in a file the
 * operator is expected to paste somewhere. Every entry below is a fixed
 * constant from the PostgreSQL error-code appendix that the exporter, the
 * coordinator or the operator can actually act on; anything else is reported as
 * `unknown` and the failure is identified by the exporter's own stable code.
 */
const ALLOWED_SQLSTATES: ReadonlySet<string> = new Set([
  // Connection exceptions.
  "08000", "08003", "08006", "08P01",
  // Feature not supported / invalid transaction state.
  "0A000", "25000", "25001", "25006", "25P02",
  // Wrong database, schema or object.
  "3D000", "3F000", "42501", "42601", "42703", "42883", "42P01", "42P02",
  // Concurrency.
  "40001", "40P01", "55006", "55P03",
  // Authorization.
  "28000", "28P01",
  // Resource limits, cancellation and shutdown.
  "53100", "53200", "53300", "53400", "54000", "55000",
  "57014", "57P01", "57P02", "57P03", "57P05",
  // Storage and internal faults.
  "58000", "58030", "XX000", "XX001", "XX002",
]);

/**
 * Parse an ErrorResponse/NoticeResponse down to an allowlisted SQLSTATE.
 *
 * Nothing else survives. PostgreSQL may quote arbitrary row values in the `M`
 * primary message exactly as it does in `D`, `H`, `q`, `Q` and `W` — a check
 * constraint violation prints the failing row, and a `RAISE` in a source
 * function prints whatever it was given. Regex redaction cannot make an unknown
 * private value safe, because there is no pattern that describes "a note this
 * user wrote". So the parser reads the fields, keeps at most a fixed constant,
 * and never retains a byte of server-authored text.
 */
function parseNoticeFields(payload: Buffer): { sqlstate: string } {
  let sqlstate = "";
  let offset = 0;
  while (offset < payload.length) {
    const code = payload[offset];
    if (code === 0) break;
    const end = payload.indexOf(0, offset + 1);
    if (end < 0) break;
    if (code === 0x43 /* C: SQLSTATE */) {
      const value = payload.toString("utf8", offset + 1, end);
      if (ALLOWED_SQLSTATES.has(value)) sqlstate = value;
    }
    offset = end + 1;
  }
  return { sqlstate };
}

/** Build the one failure shape the exporter reports for a server error. */
function serverError(sqlstate: string, message: string): ExportError {
  return new ExportError(`pg.${sqlstate || "unknown"}`, message, { sqlstate: sqlstate || "unknown" });
}

function xorInPlace(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

function pbkdf2Sha256(password: Buffer, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, 32, "sha256", (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * SASLprep, to the extent it matters here.
 *
 * A password of ASCII printable characters is already its own SASLprep output,
 * which covers every credential this exporter is expected to see. Anything else
 * gets NFKC, which is SASLprep's normalisation step; the prohibited-character
 * and bidi rules are not implemented, and a password needing them would fail
 * authentication visibly rather than silently authenticating as something else.
 */
function saslPrep(password: string): Buffer {
  if (/^[\x21-\x7e]*$/.test(password)) return Buffer.from(password, "utf8");
  return Buffer.from(password.normalize("NFKC"), "utf8");
}

export type ScramClientFinal = {
  /** The `c=...,r=...,p=...` message sent back to the server. */
  clientFinalMessage: string;
  /** What the server's `v=` must equal, base64. Mutual authentication. */
  expectedServerSignature: string;
};

/**
 * The whole of SCRAM-SHA-256's client side, as a pure function.
 *
 * It is separated from the connection so it can be checked against the RFC 7677
 * worked example. The local test cluster authenticates with `trust`, so without
 * this seam the SCRAM path would ship never having computed a proof anyone
 * checked, and a wrong proof looks identical to a wrong password.
 */
export async function scramClientFinal(input: {
  password: string;
  clientNonce: string;
  serverFirstMessage: string;
  /**
   * Optional bare message used by the RFC worked-vector test. PostgreSQL puts
   * the user in its startup packet and deliberately uses `n=` here, so the
   * connection path leaves this unset.
   */
  clientFirstBare?: string;
}): Promise<ScramClientFinal> {
  const attributes = new Map(
    input.serverFirstMessage.split(",").map((part) => [part.slice(0, 1), part.slice(2)] as const),
  );
  const serverNonce = attributes.get("r") ?? "";
  const salt = Buffer.from(attributes.get("s") ?? "", "base64");
  const iterations = Number.parseInt(attributes.get("i") ?? "", 10);

  if (!serverNonce.startsWith(input.clientNonce) || serverNonce.length <= input.clientNonce.length) {
    throw new ExportError(
      "auth_nonce_mismatch",
      "Server nonce does not extend the client nonce. Refusing to continue.",
    );
  }
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > SCRAM_ITERATION_CEILING) {
    throw new ExportError(
      "auth_iteration_count",
      `Server asked for an implausible SCRAM iteration count (${String(iterations)}).`,
    );
  }
  if (salt.length === 0) {
    throw new ExportError("auth_missing_salt", "Server sent no SCRAM salt.");
  }

  const clientFirstBare = input.clientFirstBare ?? `n=,r=${input.clientNonce}`;
  if (!clientFirstBare.endsWith(`,r=${input.clientNonce}`)) {
    throw new ExportError(
      "auth_nonce_mismatch",
      "The client-first message does not carry the nonce used by the server.",
    );
  }
  const saltedPassword = await pbkdf2Sha256(saslPrep(input.password), salt, iterations);
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
  const authMessage = `${clientFirstBare},${input.serverFirstMessage},${clientFinalWithoutProof}`;
  const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
  const proof = xorInPlace(clientKey, clientSignature);
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest();
  const expectedServerSignature = createHmac("sha256", serverKey).update(authMessage).digest();

  return {
    clientFinalMessage: `${clientFinalWithoutProof},p=${proof.toString("base64")}`,
    expectedServerSignature: expectedServerSignature.toString("base64"),
  };
}

/** Constant-time comparison of the server's `v=` against what we computed. */
export function scramServerSignatureMatches(serverFinalMessage: string, expected: string): boolean {
  const verifier = serverFinalMessage.startsWith("v=")
    ? serverFinalMessage.slice(2).split(",")[0]
    : "";
  const actual = Buffer.from(verifier, "base64");
  const wanted = Buffer.from(expected, "base64");
  if (actual.length === 0 || actual.length !== wanted.length) return false;
  return timingSafeEqual(actual, wanted);
}

export class WireConnection {
  #socket: Socket | TLSSocket;
  #pending = EMPTY;
  #command: PendingCommand | null = null;
  #closed = false;
  #fatal: ExportError | null = null;
  #parameters = new Map<string, string>();
  #onFatal: Array<(error: ExportError) => void> = [];
  /** One outstanding backpressure wait at a time. See the `d` case in #dispatch. */
  #awaitingDrain = false;

  private constructor(socket: Socket | TLSSocket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (error: Error) => {
      this.#failEverything(
        new ExportError("connection_error", `Connection error: ${redact(error.message)}`),
      );
    });
    socket.on("close", () => {
      if (!this.#closed) {
        this.#failEverything(
          new ExportError("connection_closed", "Server closed the connection unexpectedly."),
        );
      }
    });
  }

  /** Server parameters reported at startup, e.g. `server_version`. */
  parameter(name: string): string | undefined {
    return this.#parameters.get(name);
  }

  get isTls(): boolean {
    return this.#socket instanceof Object && "encrypted" in this.#socket;
  }

  /** The negotiated TLS protocol, for the manifest. Null on a Unix socket. */
  tlsProtocol(): string | null {
    const socket = this.#socket as TLSSocket;
    return typeof socket.getProtocol === "function" ? socket.getProtocol() : null;
  }

  static async connect(options: WireConnectOptions): Promise<WireConnection> {
    const socket = await openSocket(options);
    const connection = new WireConnection(socket);
    try {
      await connection.#startup(options);
      return connection;
    } catch (error) {
      // Startup authentication can fail before the caller receives a
      // WireConnection to close. Drop the socket here so a rejected SCRAM or
      // malformed startup response cannot leave an unauthenticated connection
      // alive until the peer's idle timeout.
      connection.destroy();
      throw error;
    }
  }

  async #startup(options: WireConnectOptions): Promise<void> {
    const startup = Buffer.alloc(4);
    startup.writeInt32BE(PROTOCOL_VERSION_3, 0);
    this.#write(
      frontendMessage(
        null,
        Buffer.concat([
          startup,
          cStrings([
            ["user", options.user],
            ["database", options.database],
            ["application_name", options.applicationName],
            ["client_encoding", "UTF8"],
            // The exporter must never sit in an idle open transaction holding a
            // snapshot against production. These are belt and braces around the
            // per-statement timeouts set inside the transaction itself.
            ["options", "-c idle_in_transaction_session_timeout=300000"],
          ]),
        ]),
      ),
    );
    await this.#authenticate(options);
  }

  #authenticate(options: WireConnectOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      /**
       * The authentication phases, in the only order they may occur.
       *
       * Two things make the ordering load-bearing rather than decorative. A
       * server that answers `ReadyForQuery` without ever sending
       * `AuthenticationOk` would otherwise open a session nobody authenticated,
       * and a server that sends `AuthenticationOk` while the client is still
       * inside PBKDF2 would otherwise complete startup before its own SCRAM
       * proof was checked. Both are rejected by phase, and then rejected a
       * second time by the completion facts below, so a future edit to one
       * cannot quietly re-open the other.
       */
      type AuthenticationPhase =
        | "awaiting-method"
        | "awaiting-password-result"
        | "awaiting-sasl-continue"
        | "deriving-sasl-final"
        | "awaiting-sasl-final"
        | "awaiting-authentication-ok"
        | "awaiting-ready";

      let phase: AuthenticationPhase = "awaiting-method";
      let scram: { clientNonce: string; expectedServerSignature: string } | null = null;
      let timer: NodeJS.Timeout | null = null;
      let settled = false;

      // Facts, not phases. `settleSuccess` requires all of them, so success can
      // never be reached by a phase transition alone.
      let sawAuthenticationOk = false;
      let scramStarted = false;
      let serverProofVerified = false;
      let credentialChallenged = false;
      const holdsCredential = options.password !== null && !options.password.isEmpty;

      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.#authHandler = null;
        this.#onFatal = this.#onFatal.filter((h) => h !== onFatal);
        if (error) reject(toExportError(error));
        else resolve();
      };

      /**
       * The only path to a successful startup.
       *
       * Every condition is re-checked here even though the phase machine
       * already enforces it. `phase === "awaiting-ready"` is one boolean away
       * from being wrong; these are the properties that actually matter.
       */
      const settleSuccess = () => {
        if (!sawAuthenticationOk) {
          settle(
            new ExportError(
              "auth_protocol_violation",
              "The server completed startup without ever sending AuthenticationOk.",
            ),
          );
          return;
        }
        if (scramStarted && !serverProofVerified) {
          settle(
            new ExportError(
              "auth_protocol_violation",
              "SCRAM authentication started but the server never proved itself. Refusing the connection.",
            ),
          );
          return;
        }
        if (holdsCredential && !credentialChallenged) {
          settle(
            new ExportError(
              "auth_no_challenge",
              "The server accepted this connection without asking for the configured credential. Refusing: an unauthenticated session is not proof of the source.",
            ),
          );
          return;
        }
        settle();
      };

      const onFatal = (error: ExportError) => settle(error);
      this.#onFatal.push(onFatal);
      timer = setTimeout(() => {
        settle(
          new ExportError(
            "auth_timeout",
            `Timed out waiting for PostgreSQL authentication after ${options.connectTimeoutMs}ms.`,
          ),
        );
      }, options.connectTimeoutMs);

      const handle = async (type: string, payload: Buffer): Promise<void> => {
        if (settled) return;
        try {
          if (type === "E") {
            const { sqlstate } = parseNoticeFields(payload);
            settle(serverError(sqlstate, "Authentication refused by the server."));
            return;
          }
          if (type === "Z") {
            if (phase !== "awaiting-ready") {
              settle(
                new ExportError(
                  "auth_protocol_violation",
                  "The server sent ReadyForQuery before authentication completed.",
                ),
              );
              return;
            }
            settleSuccess();
            return;
          }
          if (type !== "R") return;

          if (payload.length < 4) {
            settle(new ExportError("auth_protocol_violation", "The server sent a truncated authentication message."));
            return;
          }
          const kind = payload.readInt32BE(0);
          if (kind === 0) {
            // AuthenticationOk is accepted after the opening method offer (the
            // trust/peer path used by the local Unix-socket fixture), after a
            // cleartext password was sent, and after a SCRAM server proof was
            // verified. Nowhere else.
            if (
              phase === "awaiting-method" ||
              phase === "awaiting-password-result" ||
              phase === "awaiting-authentication-ok"
            ) {
              sawAuthenticationOk = true;
              phase = "awaiting-ready";
              return;
            }
            settle(new ExportError("auth_protocol_violation", "The server sent AuthenticationOk out of order."));
            return;
          }
          if (kind === 3) {
            // Cleartext over a plaintext TCP socket would put the password on
            // the wire. It is only reachable here on a Unix socket.
            if (phase !== "awaiting-method") {
              settle(new ExportError("auth_protocol_violation", "The server sent cleartext authentication out of order."));
              return;
            }
            if (options.tls.kind !== "unix-socket") {
              settle(
                new ExportError(
                  "auth_cleartext_refused",
                  "Server asked for a cleartext password over TCP. Refusing; use a server configured for SCRAM-SHA-256.",
                ),
              );
              return;
            }
            const password = options.password;
            if (!password) {
              settle(new ExportError("auth_password_required", "Server requires a password and none was supplied."));
              return;
            }
            credentialChallenged = true;
            this.#write(frontendMessage("p", Buffer.from(`${password.reveal()}\0`, "utf8")));
            phase = "awaiting-password-result";
            return;
          }
          if (kind === 5) {
            settle(
              new ExportError(
                "auth_md5_refused",
                "Server asked for MD5 password authentication, which is deprecated and weak. Refusing; require SCRAM-SHA-256.",
              ),
            );
            return;
          }
          if (kind === 10) {
            if (phase !== "awaiting-method") {
              settle(new ExportError("auth_protocol_violation", "The server sent SASL authentication out of order."));
              return;
            }
            const mechanisms = payload
              .toString("utf8", 4)
              .split("\0")
              .filter((m) => m.length > 0);
            // Mechanism names are an IANA registry, not free text. An
            // unrecognised one is counted, never echoed.
            const known = mechanisms.filter((mechanism) => /^[A-Z0-9-]{1,32}$/.test(mechanism));
            if (!mechanisms.includes(SCRAM_SHA_256)) {
              settle(
                new ExportError(
                  "auth_mechanism_unsupported",
                  `Server did not offer ${SCRAM_SHA_256}; this client implements no other SASL mechanism.`,
                  { offered: known.includes(`${SCRAM_SHA_256}-PLUS`) ? `${SCRAM_SHA_256}-PLUS` : "other", count: mechanisms.length },
                ),
              );
              return;
            }
            const password = options.password;
            if (!password) {
              settle(new ExportError("auth_password_required", "Server requires a password and none was supplied."));
              return;
            }
            const clientNonce = randomBytes(18).toString("base64");
            scram = { clientNonce, expectedServerSignature: "" };
            scramStarted = true;
            credentialChallenged = true;
            const initial = Buffer.from(`n,,n=,r=${clientNonce}`, "utf8");
            const header = Buffer.alloc(4);
            header.writeInt32BE(initial.length, 0);
            this.#write(
              frontendMessage(
                "p",
                Buffer.concat([Buffer.from(`${SCRAM_SHA_256}\0`, "utf8"), header, initial]),
              ),
            );
            phase = "awaiting-sasl-continue";
            return;
          }
          if (kind === 11) {
            if (phase !== "awaiting-sasl-continue" || !scram || !options.password) {
              settle(new ExportError("auth_protocol_violation", "Unexpected SASL continue."));
              return;
            }
            // Set before the await. Frames are handled one at a time, so a
            // coalesced AuthenticationOk queued behind this one still meets a
            // phase that refuses it after PBKDF2 returns.
            phase = "deriving-sasl-final";
            const final = await scramClientFinal({
              password: options.password.reveal(),
              clientNonce: scram.clientNonce,
              serverFirstMessage: payload.toString("utf8", 4),
            });
            scram = { ...scram, expectedServerSignature: final.expectedServerSignature };
            this.#write(frontendMessage("p", Buffer.from(final.clientFinalMessage, "utf8")));
            phase = "awaiting-sasl-final";
            return;
          }
          if (kind === 12) {
            if (phase !== "awaiting-sasl-final" || !scram) {
              settle(new ExportError("auth_protocol_violation", "Unexpected SASL final."));
              return;
            }
            // Verifying the server signature is what makes SCRAM mutual. Skipping
            // it would let anything that can answer on the port impersonate the
            // source database.
            if (!scramServerSignatureMatches(payload.toString("utf8", 4), scram.expectedServerSignature)) {
              settle(
                new ExportError(
                  "auth_server_signature_mismatch",
                  "Server failed SCRAM mutual authentication. This is not the database it claims to be.",
                ),
              );
              return;
            }
            serverProofVerified = true;
            phase = "awaiting-authentication-ok";
            return;
          }
          settle(
            new ExportError(
              "auth_mechanism_unsupported",
              `Server requested authentication method ${kind}, which this client does not implement.`,
            ),
          );
        } catch (error) {
          settle(error);
        }
      };

      // Backend frames can be coalesced in one TCP read. AuthenticationSASL
      // continue performs PBKDF2 asynchronously, so dispatching each frame
      // directly would allow a following AuthenticationOk/ReadyForQuery to
      // race it and accidentally complete startup without a verified proof.
      // Serialize the handler and let the explicit phase checks reject frames
      // that are still out of order after the preceding work finishes.
      let authenticationQueue = Promise.resolve();
      this.#authHandler = (type: string, payload: Buffer) => {
        authenticationQueue = authenticationQueue.then(() => handle(type, payload));
        authenticationQueue.catch((error: unknown) => settle(error));
      };
    });
  }

  #authHandler: ((type: string, payload: Buffer) => void) | null = null;

  #write(buffer: Buffer): void {
    this.#socket.write(buffer);
  }

  #onData(chunk: Buffer): void {
    let buffer = this.#pending.length > 0 ? Buffer.concat([this.#pending, chunk]) : chunk;
    let offset = 0;
    while (buffer.length - offset >= 5) {
      const length = buffer.readInt32BE(offset + 1);
      if (length < 4 || length > 0x3fffffff) {
        this.#failEverything(new ExportError("protocol_violation", "Malformed message length from server."));
        return;
      }
      if (buffer.length - offset < length + 1) break;
      const type = String.fromCharCode(buffer[offset]);
      const payload = buffer.subarray(offset + 5, offset + 1 + length);
      offset += 1 + length;
      try {
        this.#dispatch(type, payload);
      } catch (error) {
        this.#failEverything(toExportError(error));
        return;
      }
    }
    this.#pending = offset < buffer.length ? Buffer.from(buffer.subarray(offset)) : EMPTY;
    buffer = EMPTY;
  }

  #dispatch(type: string, payload: Buffer): void {
    if (this.#authHandler) {
      if (type === "S") {
        const parts = payload.toString("utf8").split("\0");
        this.#parameters.set(parts[0], parts[1] ?? "");
        return;
      }
      if (type === "K" || type === "N") return;
      this.#authHandler(type, payload);
      return;
    }

    const command = this.#command;
    switch (type) {
      case "S": {
        const parts = payload.toString("utf8").split("\0");
        this.#parameters.set(parts[0], parts[1] ?? "");
        return;
      }
      case "N":
      case "K":
        return;
      case "T": {
        if (!command) return;
        const count = payload.readInt16BE(0);
        let offset = 2;
        for (let i = 0; i < count; i += 1) {
          const end = payload.indexOf(0, offset);
          command.fields.push({ name: payload.toString("utf8", offset, end) });
          offset = end + 1 + 18;
        }
        return;
      }
      case "D": {
        if (!command) return;
        const count = payload.readInt16BE(0);
        const row: Array<string | null> = [];
        let offset = 2;
        for (let i = 0; i < count; i += 1) {
          const size = payload.readInt32BE(offset);
          offset += 4;
          if (size === -1) {
            row.push(null);
          } else {
            row.push(payload.toString("utf8", offset, offset + size));
            offset += size;
          }
        }
        command.rows.push(row);
        return;
      }
      case "H":
        return; // CopyOutResponse: the sink was supplied with the command.
      case "d": {
        if (!command?.copy) return;
        const drained = command.copy.write(payload);
        // `pause()` stops the *socket*, but the message loop that called us is
        // already iterating a chunk that may hold hundreds of CopyData messages,
        // and every one of them still gets dispatched. Registering a drain
        // waiter per message would attach hundreds of concurrent listeners to
        // one stream - enough to trip Node's MaxListenersExceededWarning on
        // every burst. One waiter is sufficient: the drain that resolves it is
        // emitted once the buffer has flushed everything written into it.
        if (!drained && !this.#awaitingDrain) {
          this.#awaitingDrain = true;
          this.#socket.pause();
          command.copy.whenDrained().then(
            () => {
              this.#awaitingDrain = false;
              this.#socket.resume();
            },
            (error: unknown) => {
              this.#awaitingDrain = false;
              this.#failEverything(toExportError(error));
            },
          );
        }
        return;
      }
      case "c":
        return; // CopyDone; CommandComplete follows.
      case "C": {
        if (!command) return;
        // A CommandComplete tag is a fixed vocabulary of SQL words plus counts,
        // but it arrives as server-authored bytes and the exporter quotes it in
        // a failure message when it does not parse. Anything outside that shape
        // is replaced here, so no unexpected server string can reach a
        // diagnostic through the tag.
        const tag = payload.toString("utf8", 0, Math.max(0, payload.length - 1));
        command.commandTag =
          tag.length <= 64 && /^[A-Za-z]+(?: [A-Za-z]+)*(?: \d+){0,2}$/.test(tag) ? tag : "unrecognized";
        return;
      }
      case "I":
        return;
      case "E": {
        const { sqlstate } = parseNoticeFields(payload);
        const failure = serverError(sqlstate, "PostgreSQL refused the statement.");
        if (command) command.failure = failure;
        else this.#fatal = failure;
        return;
      }
      case "Z": {
        if (!command) return;
        this.#command = null;
        // Backpressure belongs to the COPY that caused it. The sink for that
        // relation is about to be closed, so any wait still outstanding against
        // it will never settle; carrying the flag into the next relation would
        // leave the socket paused with nothing left to resume it.
        this.#releaseBackpressure();
        if (command.failure) command.reject(command.failure);
        else
          command.resolve({
            fields: command.fields,
            rows: command.rows,
            commandTag: command.commandTag,
          });
        return;
      }
      default:
        return;
    }
  }

  /** Clear the one-outstanding-wait flag and let the socket read again. */
  #releaseBackpressure(): void {
    if (!this.#awaitingDrain) return;
    this.#awaitingDrain = false;
    this.#socket.resume();
  }

  #failEverything(error: ExportError): void {
    this.#fatal ??= error;
    this.#releaseBackpressure();
    for (const handler of this.#onFatal) handler(error);
    const command = this.#command;
    this.#command = null;
    if (command) command.reject(error);
  }

  #send(sql: string, copy: CopySink | null): Promise<QueryResult> {
    if (this.#fatal) return Promise.reject(this.#fatal);
    if (this.#command) {
      return Promise.reject(
        new ExportError("protocol_violation", "A statement is already in flight on this connection."),
      );
    }
    return new Promise<QueryResult>((resolve, reject) => {
      this.#command = { resolve, reject, fields: [], rows: [], commandTag: "", failure: null, copy };
      this.#write(frontendMessage("Q", Buffer.from(`${sql}\0`, "utf8")));
    });
  }

  /** Run one statement and buffer its rows. Only ever used for small results. */
  query(sql: string): Promise<QueryResult> {
    return this.#send(sql, null);
  }

  /** Stream `COPY ... TO STDOUT`, handing every payload straight to the sink. */
  copyOut(sql: string, sink: CopySink): Promise<QueryResult> {
    return this.#send(sql, sink);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#write(frontendMessage("X", EMPTY));
    } catch {
      // The socket may already be gone; the destroy below is what matters.
    }
    await new Promise<void>((resolve) => {
      this.#socket.end(() => resolve());
      this.#socket.once("close", () => resolve());
      setTimeout(resolve, 2000).unref?.();
    });
    this.#socket.destroy();
  }

  /**
   * Drop the connection without a clean shutdown.
   *
   * This is what an abort does: the server rolls the open transaction back, and
   * nothing that was streamed so far can be mistaken for a finished export.
   */
  destroy(): void {
    this.#closed = true;
    this.#socket.destroy();
  }
}

function toExportError(error: unknown): ExportError {
  if (error instanceof ExportError) return error;
  return new ExportError("unexpected_error", redact(error instanceof Error ? error.message : String(error)));
}

async function openSocket(options: WireConnectOptions): Promise<Socket | TLSSocket> {
  const isUnixSocket = options.tls.kind === "unix-socket";
  if (isUnixSocket && !options.host.startsWith("/")) {
    throw new ExportError(
      "transport_mismatch",
      "A Unix-socket connection needs an absolute socket directory as its host.",
    );
  }
  if (!isUnixSocket && options.host.startsWith("/")) {
    throw new ExportError("transport_mismatch", "A TCP connection needs a hostname, not a socket path.");
  }

  const raw = await new Promise<Socket>((resolve, reject) => {
    const socket = isUnixSocket
      ? netConnect({ path: `${options.host}/.s.PGSQL.${options.port}` })
      : netConnect({ host: options.host, port: options.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ExportError("connect_timeout", `Timed out connecting after ${options.connectTimeoutMs}ms.`));
    }, options.connectTimeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new ExportError("connect_failed", `Cannot reach the source (${error.code ?? "unknown"}).`, {
          errno: error.code ?? "unknown",
        }),
      );
    });
  });

  if (isUnixSocket) return raw;

  // TLS is not negotiable on a TCP connection. There is no plaintext fallback
  // and no "prefer" mode: if the server will not do TLS, the export stops.
  const answer = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const request = Buffer.alloc(8);
    request.writeInt32BE(8, 0);
    request.writeInt32BE(SSL_REQUEST_CODE, 4);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      raw.destroy();
      reject(new ExportError("tls_timeout", `Timed out waiting for TLS negotiation after ${options.connectTimeoutMs}ms.`));
    }, options.connectTimeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      raw.off("data", onData);
      raw.off("error", onError);
      raw.off("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (chunk.length === 0) {
        reject(new ExportError("tls_protocol_violation", "The server sent an empty response to the TLS request."));
      } else {
        resolve(String.fromCharCode(chunk[0]));
      }
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ExportError("tls_negotiation_failed", `TLS negotiation failed: ${redact(error.message)}`));
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ExportError("tls_connection_closed", "The server closed the connection during TLS negotiation."));
    };
    raw.on("data", onData);
    raw.once("error", onError);
    raw.once("close", onClose);
    raw.write(request);
  });
  if (answer !== "S") {
    raw.destroy();
    throw new ExportError(
      "tls_refused",
      "The server refused TLS. This exporter has no plaintext fallback; connect to a TLS-capable endpoint.",
    );
  }

  const tlsPolicy = options.tls;
  return await new Promise<TLSSocket>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    let secure: TLSSocket;
    try {
      secure = tlsConnect({
        socket: raw,
        servername: options.host,
        // Both of these are the defaults; they are written out because turning
        // either off is the single change that would silently make this exporter
        // unsafe, and it should be visible in a diff.
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(tlsPolicy.kind === "verify-full" && tlsPolicy.caCertificatesPem
          ? { ca: tlsPolicy.caCertificatesPem }
          : {}),
      });
    } catch (error) {
      reject(new ExportError("tls_failed", `TLS handshake failed: ${redact(error instanceof Error ? error.message : String(error))}`));
      return;
    }
    timer = setTimeout(() => {
      finish(() => {
        secure.destroy();
        reject(new ExportError("tls_timeout", `Timed out completing TLS after ${options.connectTimeoutMs}ms.`));
      });
    }, options.connectTimeoutMs);
    secure.once("secureConnect", () => {
      if (settled) return;
      if (!secure.authorized) {
        const reason = secure.authorizationError;
        finish(() => {
          secure.destroy();
          reject(
            new ExportError(
              "tls_verification_failed",
              `TLS certificate verification failed (${redact(String(reason))}).`,
            ),
          );
        });
        return;
      }
      finish(() => resolve(secure));
    });
    secure.once("error", (error: Error) => {
      finish(() => {
        secure.destroy();
        reject(new ExportError("tls_failed", `TLS handshake failed: ${redact(error.message)}`));
      });
    });
    secure.once("close", () => {
      finish(() => reject(new ExportError("tls_connection_closed", "The server closed the connection during TLS.")));
    });
  });
}

/** Quote an SQL identifier. Rejects anything that is not a plain relation name. */
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) || name.length > 63) {
    throw new ExportError(
      "invalid_identifier",
      `Refusing to build SQL around the identifier ${JSON.stringify(name)}.`,
    );
  }
  return `"${name}"`;
}

/** Quote a string literal for the few places a literal is unavoidable. */
export function quoteLiteral(value: string): string {
  if (value.includes("\0")) {
    throw new ExportError("invalid_literal", "A SQL literal cannot contain a null byte.");
  }
  return `'${value.replaceAll("'", "''")}'`;
}
