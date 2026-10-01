import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSecureContext, TLSSocket } from "node:tls";
import { describeFailure, ExportError } from "../shared/redaction.ts";
import { Secret } from "../shared/secret.ts";
import {
  WireConnection,
  scramClientFinal,
  scramServerSignatureMatches,
  type ScramClientFinal,
} from "./wire.ts";

const PROTOCOL_VERSION_3 = 196608;
const SSL_REQUEST_CODE = 80877103;

function backendMessage(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, "latin1");
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

function authentication(kind: number, message = ""): Buffer {
  const payload = Buffer.alloc(4 + Buffer.byteLength(message));
  payload.writeInt32BE(kind, 0);
  Buffer.from(message, "utf8").copy(payload, 4);
  return backendMessage("R", payload);
}

type FakePostgresState = {
  authenticated: boolean;
  clientFinal: string | null;
  error: Error | null;
};

type FakePostgresServer = {
  port: number;
  state: FakePostgresState;
  close(): Promise<void>;
};

type FakePostgresMode =
  | "normal"
  | "coalesced-premature-ready"
  | "missing-server-proof"
  | "bad-server-proof"
  | "premature-server-proof"
  | "ready-without-authentication"
  | "ok-without-challenge"
  | "startup-error";

/**
 * A tiny TLS-wrapped PostgreSQL startup/SCRAM peer.
 *
 * It is intentionally separate from PostgreSQL: this test proves the custom
 * transport sends an SSLRequest, verifies a certificate, computes a SCRAM
 * proof and checks the server proof. The disposable PostgreSQL fixture then
 * covers the actual query/COPY path over its Unix socket.
 */
async function startFakePostgres(
  key: string,
  certificate: string,
  password: string,
  respondToStartup = true,
  mode: FakePostgresMode = "normal",
  startupErrorMessage = "",
): Promise<FakePostgresServer> {
  const state: FakePostgresState = { authenticated: false, clientFinal: null, error: null };
  const sockets = new Set<Socket | TLSSocket>();
  const server: NetServer = createNetServer((raw) => {
    sockets.add(raw);
    raw.on("error", () => {});
    raw.once("data", (request: Buffer) => {
      if (request.length < 8 || request.readInt32BE(0) !== 8 || request.readInt32BE(4) !== SSL_REQUEST_CODE) {
        state.error = new Error("fake peer did not receive a PostgreSQL SSLRequest");
        raw.destroy();
        return;
      }

      raw.write("S");
      const secure = new TLSSocket(raw, {
        isServer: true,
        secureContext: createSecureContext({ key, cert: certificate }),
      });
      sockets.add(secure);
      secure.on("error", (error) => {
        // A client deliberately rejecting our certificate closes during the
        // handshake. That is expected in the rejection tests, not a test error.
        if (!state.error && !String(error.message).includes("certificate")) state.error = error;
      });
      secure.once("secure", () => {
        if (mode === "startup-error") handleStartupError(secure, startupErrorMessage);
        else if (respondToStartup) handlePostgresStartup(secure, state, password, mode);
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("fake PostgreSQL server did not expose a TCP port");
  }

  return {
    port: address.port,
    state,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function handleStartupError(secure: TLSSocket, message: string): void {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  secure.on("data", (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    if (buffered.length < 4) return;
    const length = buffered.readInt32BE(0);
    if (length < 8 || buffered.length < length) return;
    const error = Buffer.from(`SERROR\0C28P01\0M${message}\0\0`, "utf8");
    secure.write(backendMessage("E", error));
    buffered = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  });
}

function handlePostgresStartup(
  secure: TLSSocket,
  state: FakePostgresState,
  password: string,
  mode: FakePostgresMode = "normal",
): void {
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  let startup = true;
  let authenticatedRequest: Promise<void> = Promise.resolve();
  let clientNonce = "";
  let serverFirst = "";

  secure.on("data", (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    for (;;) {
      if (startup) {
        if (buffered.length < 4) return;
        const length = buffered.readInt32BE(0);
        if (length < 8 || buffered.length < length) return;
        const startupPayload = buffered.subarray(4, length);
        buffered = buffered.subarray(length);
        if (startupPayload.readInt32BE(0) !== PROTOCOL_VERSION_3) {
          state.error = new Error("fake peer received an unexpected startup protocol");
          secure.destroy();
          return;
        }
        startup = false;
        if (mode === "ready-without-authentication") {
          secure.write(backendMessage("Z", Buffer.from("I")));
          continue;
        }
        if (mode === "ok-without-challenge") {
          secure.write(Buffer.concat([authentication(0), backendMessage("Z", Buffer.from("I"))]));
          continue;
        }
        if (mode === "premature-server-proof") {
          secure.write(authentication(12, "v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
          continue;
        }
        secure.write(authentication(10, "SCRAM-SHA-256\0\0"));
        continue;
      }

      if (buffered.length < 5) return;
      const length = buffered.readInt32BE(1);
      if (length < 4 || buffered.length < length + 1) return;
      const type = String.fromCharCode(buffered[0]);
      const payload = buffered.subarray(5, length + 1);
      buffered = buffered.subarray(length + 1);
      if (type !== "p") continue;

      if (clientNonce === "") {
        const mechanismEnd = payload.indexOf(0);
        if (mechanismEnd < 0 || payload.toString("utf8", 0, mechanismEnd) !== "SCRAM-SHA-256") {
          state.error = new Error("fake peer received an unexpected SASL mechanism");
          secure.destroy();
          return;
        }
        const initialLength = payload.readInt32BE(mechanismEnd + 1);
        const initialStart = mechanismEnd + 5;
        const initial = payload.toString("utf8", initialStart, initialStart + initialLength);
        const nonce = /^n,,n=,r=(.+)$/.exec(initial)?.[1] ?? "";
        if (nonce.length === 0) {
          state.error = new Error("fake peer received an invalid SCRAM client nonce");
          secure.destroy();
          return;
        }
        clientNonce = nonce;
        const salt = Buffer.from("synthetic-salt", "utf8").toString("base64");
        serverFirst = `r=${clientNonce}server,s=${salt},i=4096`;
        if (mode === "coalesced-premature-ready") {
          secure.write(
            Buffer.concat([
              authentication(11, serverFirst),
              authentication(0),
              backendMessage("Z", Buffer.from("I")),
            ]),
          );
        } else {
          secure.write(authentication(11, serverFirst));
        }
        continue;
      }

      const finalMessage = payload.toString("utf8");
      state.clientFinal = finalMessage;
      authenticatedRequest = authenticatedRequest.then(async () => {
        const expected: ScramClientFinal = await scramClientFinal({
          password,
          clientNonce,
          serverFirstMessage: serverFirst,
        });
        if (finalMessage !== expected.clientFinalMessage) {
          state.error = new Error("fake peer received an incorrect SCRAM proof");
          secure.destroy();
          return;
        }
        if (mode === "missing-server-proof") {
          secure.write(Buffer.concat([authentication(0), backendMessage("Z", Buffer.from("I"))]));
        } else if (mode === "bad-server-proof") {
          secure.write(authentication(12, "v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
        } else {
          secure.write(authentication(12, `v=${expected.expectedServerSignature}`));
          secure.write(authentication(0));
          secure.write(backendMessage("Z", Buffer.from("I")));
          state.authenticated = true;
        }
      });
    }
  });
}

async function makeCertificate(hostname = "localhost"): Promise<{ directory: string; key: string; certificate: string }> {
  const directory = await mkdtemp(join(tmpdir(), "vs-wire-tls-"));
  const keyPath = join(directory, "server.key");
  const certificatePath = join(directory, "server.crt");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-subj",
      `/CN=${hostname}`,
      "-addext",
      `subjectAltName=DNS:${hostname}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  );
  if (generated.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    throw new Error(`openssl could not create the synthetic TLS certificate: ${generated.stderr}`);
  }
  return {
    directory,
    key: await readFile(keyPath, "utf8"),
    certificate: await readFile(certificatePath, "utf8"),
  };
}

test("SCRAM-SHA-256 matches the RFC 7677 worked vector and verifies the server proof", async () => {
  const result = await scramClientFinal({
    password: "pencil",
    clientNonce: "rOprNGfwEbeRWgbNEkqO",
    clientFirstBare: "n=user,r=rOprNGfwEbeRWgbNEkqO",
    serverFirstMessage:
      "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
  });

  assert.equal(
    result.clientFinalMessage,
    "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
  );
  assert.equal(result.expectedServerSignature, "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
  assert.equal(scramServerSignatureMatches(`v=${result.expectedServerSignature}`, result.expectedServerSignature), true);
  assert.equal(scramServerSignatureMatches("v=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", result.expectedServerSignature), false);
  assert.equal(scramServerSignatureMatches("not-a-server-final", result.expectedServerSignature), false);
});

test("SCRAM refuses a nonce mismatch, missing salt and excessive iteration count", async (t) => {
  await t.test("nonce mismatch", async () => {
    await assert.rejects(
      () =>
        scramClientFinal({
          password: "pencil",
          clientNonce: "client",
          serverFirstMessage: "r=other-server,s=YWJjZA==,i=4096",
        }),
      (error: unknown) => error instanceof ExportError && error.code === "auth_nonce_mismatch",
    );
  });
  await t.test("missing salt", async () => {
    await assert.rejects(
      () =>
        scramClientFinal({
          password: "pencil",
          clientNonce: "client",
          serverFirstMessage: "r=client-server,s=,i=4096",
        }),
      (error: unknown) => error instanceof ExportError && error.code === "auth_missing_salt",
    );
  });
  await t.test("excessive iterations", async () => {
    await assert.rejects(
      () =>
        scramClientFinal({
          password: "pencil",
          clientNonce: "client",
          serverFirstMessage: "r=client-server,s=YWJjZA==,i=100001",
        }),
      (error: unknown) => error instanceof ExportError && error.code === "auth_iteration_count",
    );
  });
});

test("TCP transport verifies the CA, hostname and SCRAM server proof", async (t) => {
  let certificateMaterial: Awaited<ReturnType<typeof makeCertificate>>;
  try {
    certificateMaterial = await makeCertificate();
  } catch (error) {
    t.skip(`openssl is required for the local TLS transport test: ${String(error)}`);
    return;
  }
  t.after(async () => rm(certificateMaterial.directory, { recursive: true, force: true }));

  const server = await startFakePostgres(certificateMaterial.key, certificateMaterial.certificate, "pencil");
  t.after(() => server.close());

  const connection = await WireConnection.connect({
    host: "localhost",
    port: server.port,
    user: "synthetic_user",
    database: "synthetic_db",
    password: new Secret("pencil", "synthetic password"),
    tls: { kind: "verify-full", caCertificatesPem: certificateMaterial.certificate },
    applicationName: "vaultshuffle-v2-wire-test",
    connectTimeoutMs: 5_000,
  });
  assert.equal(connection.isTls, true);
  assert.match(connection.tlsProtocol() ?? "", /^TLSv1\.[23]$/);
  await connection.close();
  assert.equal(server.state.authenticated, true);
  assert.match(server.state.clientFinal ?? "", /,p=[A-Za-z0-9+/]+=*$/);
  assert.equal(server.state.error, null, server.state.error?.message);
});

test("SCRAM startup requires ordered proofs before ReadyForQuery", async (t) => {
  let certificateMaterial: Awaited<ReturnType<typeof makeCertificate>>;
  try {
    certificateMaterial = await makeCertificate();
  } catch (error) {
    t.skip(`openssl is required for the local TLS transport test: ${String(error)}`);
    return;
  }
  t.after(async () => rm(certificateMaterial.directory, { recursive: true, force: true }));

  const connectAndReject = async (mode: FakePostgresMode, code: string) => {
    const server = await startFakePostgres(certificateMaterial.key, certificateMaterial.certificate, "pencil", true, mode);
    try {
      await assert.rejects(
        () =>
          WireConnection.connect({
            host: "localhost",
            port: server.port,
            user: "synthetic_user",
            database: "synthetic_db",
            password: new Secret("pencil", "synthetic password"),
            tls: { kind: "verify-full", caCertificatesPem: certificateMaterial.certificate },
            applicationName: "vaultshuffle-v2-wire-test",
            connectTimeoutMs: 5_000,
          }),
        (error: unknown) => error instanceof ExportError && error.code === code,
      );
      assert.equal(server.state.authenticated, false);
    } finally {
      await server.close();
    }
  };

  await t.test("coalesced SASL continue, AuthenticationOk and ReadyForQuery", async () => {
    // AuthenticationOk/ReadyForQuery arrive in the same read as SASL continue,
    // before the PBKDF2 result and before a server final proof. They must not
    // race the async SCRAM step into a successful startup.
    await connectAndReject("coalesced-premature-ready", "auth_protocol_violation");
  });
  await t.test("missing server final proof", async () => {
    await connectAndReject("missing-server-proof", "auth_protocol_violation");
  });
  await t.test("bad server final proof", async () => {
    await connectAndReject("bad-server-proof", "auth_server_signature_mismatch");
  });
  await t.test("ReadyForQuery without AuthenticationOk", async () => {
    await connectAndReject("ready-without-authentication", "auth_protocol_violation");
  });
  await t.test("premature server final proof", async () => {
    await connectAndReject("premature-server-proof", "auth_protocol_violation");
  });
  await t.test("a configured credential must be challenged", async () => {
    await connectAndReject("ok-without-challenge", "auth_no_challenge");
  });
});

test("server primary messages never enter export diagnostics", async (t) => {
  let certificateMaterial: Awaited<ReturnType<typeof makeCertificate>>;
  try {
    certificateMaterial = await makeCertificate();
  } catch (error) {
    t.skip(`openssl is required for the local TLS transport test: ${String(error)}`);
    return;
  }
  t.after(async () => rm(certificateMaterial.directory, { recursive: true, force: true }));

  const sentinel = "private-row-sentinel-7f2e1a";
  const server = await startFakePostgres(
    certificateMaterial.key,
    certificateMaterial.certificate,
    "pencil",
    true,
    "startup-error",
    sentinel,
  );
  try {
    let thrown: unknown;
    await assert.rejects(
      () =>
        WireConnection.connect({
          host: "localhost",
          port: server.port,
          user: "synthetic_user",
          database: "synthetic_db",
          password: new Secret("pencil", "synthetic password"),
          tls: { kind: "verify-full", caCertificatesPem: certificateMaterial.certificate },
          applicationName: "vaultshuffle-v2-wire-test",
          connectTimeoutMs: 5_000,
        }),
      (error: unknown) => {
        thrown = error;
        return error instanceof ExportError && error.code === "pg.28P01";
      },
    );
    assert.ok(thrown instanceof ExportError);
    assert.equal(thrown.details.sqlstate, "28P01");
    assert.equal(thrown.message, "Authentication refused by the server.");
    assert.equal(describeFailure(thrown).message, "Authentication refused by the server.");
    assert.ok(!String(thrown).includes(sentinel));
    assert.ok(!JSON.stringify(thrown).includes(sentinel));
  } finally {
    await server.close();
  }
});

test("TCP transport rejects an untrusted certificate and a hostname mismatch", async (t) => {
  let certificateMaterial: Awaited<ReturnType<typeof makeCertificate>>;
  try {
    certificateMaterial = await makeCertificate();
  } catch (error) {
    t.skip(`openssl is required for the local TLS transport test: ${String(error)}`);
    return;
  }
  t.after(async () => rm(certificateMaterial.directory, { recursive: true, force: true }));

  await t.test("untrusted CA", async () => {
    const server = await startFakePostgres(certificateMaterial.key, certificateMaterial.certificate, "pencil");
    try {
      await assert.rejects(
        () =>
          WireConnection.connect({
            host: "localhost",
            port: server.port,
            user: "synthetic_user",
            database: "synthetic_db",
            password: new Secret("pencil", "synthetic password"),
            tls: { kind: "verify-full", caCertificatesPem: "invalid CA" },
            applicationName: "vaultshuffle-v2-wire-test",
            connectTimeoutMs: 5_000,
          }),
        (error: unknown) => error instanceof ExportError && ["tls_failed", "tls_verification_failed"].includes(error.code),
      );
      assert.equal(server.state.authenticated, false);
    } finally {
      await server.close();
    }
  });

  await t.test("hostname mismatch", async () => {
    const mismatchCertificate = await makeCertificate("synthetic-other-host");
    try {
      const server = await startFakePostgres(mismatchCertificate.key, mismatchCertificate.certificate, "pencil");
      try {
        await assert.rejects(
          () =>
            WireConnection.connect({
              // The certificate is valid for synthetic-other-host only. The
              // listener is reached through localhost, so hostname verification
              // must reject the otherwise trusted certificate.
              host: "localhost",
              port: server.port,
              user: "synthetic_user",
              database: "synthetic_db",
              password: new Secret("pencil", "synthetic password"),
              tls: { kind: "verify-full", caCertificatesPem: mismatchCertificate.certificate },
              applicationName: "vaultshuffle-v2-wire-test",
              connectTimeoutMs: 5_000,
            }),
          (error: unknown) => error instanceof ExportError && ["tls_failed", "tls_verification_failed"].includes(error.code),
        );
        assert.equal(server.state.authenticated, false);
      } finally {
        await server.close();
      }
    } finally {
      await rm(mismatchCertificate.directory, { recursive: true, force: true });
    }
  });
});

test("TCP transport has no plaintext fallback", async () => {
  const server = createNetServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end("N"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(
      () =>
        WireConnection.connect({
          host: "127.0.0.1",
          port: address.port,
          user: "synthetic_user",
          database: "synthetic_db",
          password: new Secret("pencil", "synthetic password"),
          tls: { kind: "verify-full" },
          applicationName: "vaultshuffle-v2-wire-test",
          connectTimeoutMs: 5_000,
        }),
      (error: unknown) => error instanceof ExportError && error.code === "tls_refused",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("TCP TLS negotiation has a bounded timeout", async () => {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    // Accept the TCP connection but deliberately never answer SSLRequest.
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(
      () =>
        WireConnection.connect({
          host: "127.0.0.1",
          port: address.port,
          user: "synthetic_user",
          database: "synthetic_db",
          password: new Secret("pencil", "synthetic password"),
          tls: { kind: "verify-full" },
          applicationName: "vaultshuffle-v2-wire-test",
          connectTimeoutMs: 100,
        }),
      (error: unknown) => error instanceof ExportError && error.code === "tls_timeout",
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("TCP PostgreSQL authentication has a bounded timeout", async (t) => {
  let certificateMaterial: Awaited<ReturnType<typeof makeCertificate>>;
  try {
    certificateMaterial = await makeCertificate();
  } catch (error) {
    t.skip(`openssl is required for the local TLS transport test: ${String(error)}`);
    return;
  }
  t.after(async () => rm(certificateMaterial.directory, { recursive: true, force: true }));

  const server = await startFakePostgres(certificateMaterial.key, certificateMaterial.certificate, "pencil", false);
  t.after(() => server.close());
  await assert.rejects(
    () =>
      WireConnection.connect({
        host: "localhost",
        port: server.port,
        user: "synthetic_user",
        database: "synthetic_db",
        password: new Secret("pencil", "synthetic password"),
        tls: { kind: "verify-full", caCertificatesPem: certificateMaterial.certificate },
        applicationName: "vaultshuffle-v2-wire-test",
        connectTimeoutMs: 100,
      }),
    (error: unknown) => error instanceof ExportError && error.code === "auth_timeout",
  );
});
