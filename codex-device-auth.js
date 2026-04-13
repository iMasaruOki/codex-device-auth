#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_ISSUER = "https://auth.openai.com";
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TIMEOUT_SECONDS = 15 * 60;

function parseArgs(argv) {
  const args = {
    issuer: DEFAULT_ISSUER,
    clientId: DEFAULT_CLIENT_ID,
    output: path.join(process.cwd(), "auth.json"),
    pollOnly: false,
    json: false,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
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
    } else if (arg === "--timeout-seconds") {
      args.timeoutSeconds = parsePositiveInt(
        requireValue(argv, ++i, "--timeout-seconds"),
        "--timeout-seconds",
      );
    } else if (arg === "--poll-only") {
      args.pollOnly = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
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
  --timeout-seconds <n>     Poll timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})
  --poll-only               Stop after printing verification URL and code
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
    const deviceCode = await requestUserCode(apiBaseUrl, args.clientId);

    printInstructions(baseUrl, deviceCode, args.json);

    if (args.pollOnly) {
      return;
    }

    const tokenCode = await pollForToken(
      apiBaseUrl,
      deviceCode.device_auth_id,
      deviceCode.user_code,
      deviceCode.interval,
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
      user_code: deviceCode.user_code,
      device_auth_id: deviceCode.device_auth_id,
      created_at: new Date().toISOString(),
      tokens,
    };

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

async function requestUserCode(apiBaseUrl, clientId) {
  const response = await postJson(`${apiBaseUrl}/deviceauth/usercode`, {
    client_id: clientId,
  });

  const interval = parsePositiveInt(
    String(response.interval || "5").trim(),
    "deviceauth interval",
  );

  if (!response.device_auth_id || !response.user_code) {
    throw new Error("deviceauth/usercode response did not include required fields");
  }

  return {
    device_auth_id: response.device_auth_id,
    user_code: response.user_code,
    interval,
  };
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
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
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

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`request failed for ${url} with status ${response.status}${body ? `: ${body}` : ""}`);
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

function printInstructions(baseUrl, deviceCode, json) {
  const verificationUrl = `${baseUrl}/codex/device`;
  if (json) {
    console.log(
      JSON.stringify(
        {
          status: "pending",
          verification_url: verificationUrl,
          user_code: deviceCode.user_code,
          interval: deviceCode.interval,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log("OpenAI Codex device authentication");
  console.log("");
  console.log(`1. Open this URL on a browser you can use:`);
  console.log(`   ${verificationUrl}`);
  console.log("");
  console.log(`2. Enter this one-time code:`);
  console.log(`   ${deviceCode.user_code}`);
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
