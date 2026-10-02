import assert from "node:assert/strict";
import test from "node:test";
import {
  codexInventory,
  codexPolicy,
  codexPolicyArgs,
  CodexPolicyError,
  verifyCodexPolicy,
} from "../../src/main/codex-policy";
const binary = "/synthetic/bin/codex";
const cwd = "/synthetic/session";
const inventory = codexInventory({
  config: {
    features: { future_tool: true },
    mcp_servers: { personal: { command: "never-run" } },
  },
});
function reply() {
  const config = codexPolicy(binary, cwd, inventory);
  Object.assign(config.features, { network_proxy: null });
  Object.assign(config["permissions.csthink_assistant"].filesystem, {
    glob_scan_max_depth: null,
  });
  return {
    config: {
      ...config,
      skills: {
        include_instructions: config["skills.include_instructions"],
        config: [
          { path: "/synthetic/skills/personal/SKILL.md", enabled: false },
        ],
      },
      permissions: {
        csthink_assistant: config["permissions.csthink_assistant"],
      },
    },
  };
}
function rejects(
  change: (value: ReturnType<typeof reply>) => void,
  reason: CodexPolicyError["reason"],
) {
  const value = structuredClone(reply());
  change(value);
  assert.throws(
    () => verifyCodexPolicy(value, binary, cwd, inventory),
    (error) => error instanceof CodexPolicyError && error.reason === reason,
  );
}
test("restricted configuration adapts discovered features and disables each layered MCP server", () => {
  const value = reply();
  assert.equal(value.config.features.future_tool, false);
  assert.equal(value.config.features.code_mode_host, true);
  assert.equal(value.config.agents.max_depth, 0);
  assert.deepEqual(value.config.mcp_servers, { personal: { enabled: false } });
  assert.doesNotThrow(() => verifyCodexPolicy(value, binary, cwd, inventory));
  const args = codexPolicyArgs(binary, cwd, inventory);
  assert.ok(args.includes('mcp_servers={"personal"={"enabled"=false}}'));
  assert.equal(
    args.some((arg) => /version/.test(arg)),
    false,
  );
});
test("a new layered MCP server, silent map removal and management feature override are refused", () => {
  rejects((value) => {
    value.config.mcp_servers.added = { enabled: true };
  }, "mcp");
  rejects((value) => {
    value.config.mcp_servers = {};
  }, "mcp");
  rejects((value) => {
    value.config.features.shell_tool = true;
  }, "features");
  rejects((value) => {
    value.config.features.unknown_native_execution = true;
  }, "features");
  rejects((value) => {
    delete value.config.features.code_mode_host;
  }, "features");
});
test("permission expansion, inheritance, network and callback hooks cannot silently survive readback", () => {
  rejects((value) => {
    value.config.agents.max_depth = 1;
  }, "configuration");
  rejects((value) => {
    value.config.permissions.csthink_assistant.filesystem["/"] = "read";
  }, "configuration");
  rejects((value) => {
    value.config.permissions.csthink_assistant.network.enabled = true;
  }, "configuration");
  rejects((value) => {
    Object.assign(value.config.permissions.csthink_assistant, {
      extends: ":workspace",
    });
  }, "configuration");
  rejects((value) => {
    value.config.web_search = "live";
  }, "configuration");
  rejects((value) => {
    Object.assign(value.config, { notify: ["never-run"] });
  }, "configuration");
});
test("skill instructions stay out of the model instructions: the leaf is passed alone and must read back off", () => {
  const args = codexPolicyArgs(binary, cwd, inventory);
  assert.ok(args.includes("skills.include_instructions=false"));
  // A dotted leaf, never the whole table: the user's own skill switches stay as they are.
  assert.equal(
    args.some((arg) => arg.startsWith("skills=")),
    false,
  );
  rejects((value) => {
    value.config.skills.include_instructions = true;
  }, "configuration");
  rejects((value) => {
    delete (value.config.skills as { include_instructions?: boolean })
      .include_instructions;
  }, "configuration");
  rejects((value) => {
    delete (value.config as { skills?: unknown }).skills;
  }, "shape");
});
test("malformed configuration is not interpreted as an empty tool set; names are encoded as TOML keys", () => {
  for (const value of [
    {},
    { config: [] },
    { config: { mcp_servers: [] } },
    { config: { features: { shell_tool: "false" } } },
  ])
    assert.throws(() => codexInventory(value), CodexPolicyError);
  const names = {
    features: ["strange.key"],
    mcp: ["name.with.dots", 'quote"\nkey'],
  };
  const args = codexPolicyArgs(binary, cwd, names);
  assert.ok(
    args.includes(
      'mcp_servers={"name.with.dots"={"enabled"=false},"quote\\"\\nkey"={"enabled"=false}}',
    ),
  );
});
