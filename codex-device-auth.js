#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

function parseArgs(argv) {
  const args = {
    issuer: DEFAULT_ISSUER,
    clientId: DEFAULT_CLIENT_ID,
    output: path.join(process.cwd(), "auth.json"),
    userCode: "",
    deviceAuthId: "",
    json: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    intervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--issuer") {
      args.issuer = requireValue(argv, ++i, "--issuer");
    } else if (arg === "--client-id") {
      args.clientId = requireValue(argv, ++i, "--client-id");
    } else if (arg === "--output") {
      args.output = path.resolve(requireValue(argv, ++i, "--output"));
    } else if (arg === "--user-code") {
      args.userCode = requireValue(argv, ++i, "--user-code").trim();
    } else if (arg === "--device-auth-id") {
      args.deviceAuthId = requireValue(argv, ++i, "--device-auth-id").trim();
    } else if (arg === "--timeout-seconds") {
      args.timeoutSeconds = parsePositiveInt(
        requireValue(argv, ++i, "--timeout-seconds"),
        "--timeout-seconds",
      );
    } else if (arg === "--interval-seconds") {
      args.intervalSeconds = parsePositiveInt(
        requireValue(argv, ++i, "--interval-seconds"),
        "--interval-seconds",
      );
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!args.help && !args.userCode) {
    throw new Error("--user-code is required");
  }

  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node codex-device-auth.js [options]

OpenAI Codex device authentication for headless/SSH environments.

Options:
  --output <path>           Where to save the token JSON (default: ./auth.json)
  --issuer <url>            Auth issuer (default: ${DEFAULT_ISSUER})
  --client-id <id>          OAuth client id (default: ${DEFAULT_CLIENT_ID})
  --user-code <code>        One-time code shown by the Codex CLI
  --device-auth-id <id>     Optional device auth id if you also captured it
  --timeout-seconds <n>     Poll timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --interval-seconds <n>    Poll interval in seconds (default: ${DEFAULT_POLL_INTERVAL_SECONDS})
  --json                    Print machine-readable status messages
  --help, -h                Show this help
`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Argument error: ${error.message}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  try {
    const baseUrl = args.issuer.replace(/\/+$/, "");
    const apiBaseUrl = `${baseUrl}/api/accounts`;
    printInstructions(baseUrl, args.userCode, args.deviceAuthId, args.json);

    const tokenCode = await pollForToken(
      apiBaseUrl,
      args.deviceAuthId,
      args.userCode,
      args.intervalSeconds,
      args.timeoutSeconds,
      args.json,
    );

    const tokens = await exchangeCodeForTokens(
      baseUrl,
      args.clientId,
      tokenCode.authorization_code,
      tokenCode.code_verifier,
    );

    const output = {
      issuer: baseUrl,
      client_id: args.clientId,
      verification_url: `${baseUrl}/codex/device`,
      user_code: args.userCode,
      created_at: new Date().toISOString(),
      tokens,
    };

    if (args.deviceAuthId) {
      output.device_auth_id = args.deviceAuthId;
    }

    saveOutput(args.output, output);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            status: "ok",
            saved_to: args.output,
            refresh_token: Boolean(tokens.refresh_token),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Authentication completed.`);
      console.log(`Saved token JSON to ${args.output}`);
    }
  } catch (error) {
    if (args && args.json) {
      console.error(
        JSON.stringify(
          {
            status: "error",
            message: error.message,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`Authentication failed: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

async function pollForToken(
  apiBaseUrl,
  deviceAuthId,
  userCode,
  intervalSeconds,
  timeoutSeconds,
  json,
) {
  const deadline = Date.now() + timeoutSeconds * 1000;

  for (;;) {
    const response = await fetch(`${apiBaseUrl}/deviceauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(buildTokenRequestBody(deviceAuthId, userCode)),
    });

    if (response.ok) {
      const payload = await response.json();
      if (!payload.authorization_code || !payload.code_verifier) {
        throw new Error("deviceauth/token response did not include required fields");
      }
      return payload;
    }

    if (response.status !== 403 && response.status !== 404) {
      const body = await safeReadBody(response);
      throw new Error(
        `deviceauth/token failed with status ${response.status}${body ? `: ${body}` : ""}`,
      );
    }

    if (Date.now() >= deadline) {
      throw new Error(`device auth timed out after ${timeoutSeconds} seconds`);
    }

    if (!json) {
      process.stdout.write(".");
    }

    await sleep(intervalSeconds * 1000);
  }
}

function buildTokenRequestBody(deviceAuthId, userCode) {
  const body = {
    user_code: userCode,
  };

  if (deviceAuthId) {
    body.device_auth_id = deviceAuthId;
  }

  return body;
}

async function exchangeCodeForTokens(baseUrl, clientId, authorizationCode, codeVerifier) {
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: `${baseUrl}/deviceauth/callback`,
      client_id: clientId,
      code_verifier: codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`oauth/token failed with status ${response.status}${body ? `: ${body}` : ""}`);
  }

  return response.json();
}

async function safeReadBody(response) {
  try {
    return (await response.text()).trim();
  } catch (_error) {
    return "";
  }
}

function saveOutput(outputPath, output) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(outputPath, 0o600);
}

function printInstructions(baseUrl, userCode, deviceAuthId, json) {
  const verificationUrl = `${baseUrl}/codex/device`;
  if (json) {
    const output = {
      status: "pending",
      verification_url: verificationUrl,
      user_code: userCode,
    };
    if (deviceAuthId) {
      output.device_auth_id = deviceAuthId;
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log("");
  console.log("OpenAI Codex device authentication");
  console.log("");
  console.log("1. Run `codex`, choose device auth, and finish approval in the other CLI.");
  console.log("");
  console.log("2. This helper is polling for the code you passed in:");
  console.log(`   ${userCode}`);
  console.log("");
  console.log("Verification URL:");
  console.log(`   ${verificationUrl}`);
  console.log("");
  console.log("Waiting for approval");
  console.log("");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main();
