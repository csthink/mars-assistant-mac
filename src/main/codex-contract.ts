import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  rm,
  realpath,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexInstallation } from "../shared/codex";
import { record } from "./codex";
import { codexEnvironment } from "./codex-discovery";
import { CodexRpc } from "./codex-rpc";
import {
  codexInventory,
  codexPolicyArgs,
  codexToml,
  initializeRestrictedCodex,
} from "./codex-policy";
import { readToolName } from "../shared/capabilities";
import { startCodexThread } from "./codex-session";
import { TransportError } from "./transport";
/** A synthetic model endpoint measures the installed runtime; no account or personal context is loaded. */
export async function verifyCodexRuntime(
  installation: CodexInstallation,
  model: string,
  environment: NodeJS.ProcessEnv,
) {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "csthink-codex-contract-")),
  );
  const cwd = join(home, "session"),
    codexHome = join(home, ".codex");
  await mkdir(cwd);
  await mkdir(codexHome);
  const personalSkillName = "private-fixture";
  const personalSkill = join(home, ".agents", "skills", personalSkillName);
  await mkdir(personalSkill, { recursive: true });
  await writeFile(
    join(personalSkill, "SKILL.md"),
    "---\nname: private-fixture\ndescription: Synthetic private rule\n---\nUNSELECTED_SYNTHETIC_SKILL_SECRET\n",
  );
  const env = {
    ...codexEnvironment(environment, dirname(installation.path)),
    HOME: home,
    CODEX_HOME: codexHome,
  };
  let rpc: CodexRpc | undefined;
  let requests = 0,
    callbacks = 0;
  const outputs: unknown[] = [];
  let settled = false;
  let resolve!: () => void, reject!: (error: Error) => void;
  const done = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void done.catch(() => {});
  const error = () =>
    new TransportError(
      "unsupported",
      "Codex 当前运行环境未通过工具限制验证，未发送对话。请检查本地配置后重试。",
    );
  const finish = (failure?: Error) => {
    if (settled) return;
    settled = true;
    if (failure) reject(failure);
    else resolve();
  };
  const scripts = [
    "text({tools:Object.keys(tools).sort(),fetch:typeof fetch,process:typeof process,require:typeof require});",
    'text({orchestrator:await tools.skills__list({authority:{kind:"orchestrator"}}),executor:await tools.skills__list({authority:{kind:"executor"}})});',
    'let denied=false;try {await import("node:fs");} catch {denied=true;} text({nodeImportDenied:denied});',
    'let denied=0; for (const attempt of [()=>tools.exec_command({cmd:"touch forbidden-effect"}),()=>tools.apply_patch("*** Begin Patch\\n*** Add File: forbidden-effect\\n+bad\\n*** End Patch"),()=>fetch("http://127.0.0.1:1/forbidden"),()=>tools.skills__read({package:' +
      JSON.stringify(personalSkill) +
      "})]) {try {await attempt();} catch {denied++;}} text({bypassDenied:denied===4});",
    "text(await tools." +
      readToolName +
      '({attachmentId:"contract-material"}));',
  ];
  const functions = [
    {
      name: "list",
      namespace: "skills",
      arguments: JSON.stringify({ authority: { kind: "orchestrator" } }),
    },
    {
      name: "list",
      namespace: "skills",
      arguments: JSON.stringify({ authority: { kind: "executor" } }),
    },
    {
      name: "read",
      namespace: "skills",
      arguments: JSON.stringify({ package: personalSkill }),
    },
    {
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "touch forbidden-effect" }),
    },
    {
      name: "apply_patch",
      arguments: JSON.stringify({
        patch:
          "*** Begin Patch\n*** Add File: forbidden-effect\n+bad\n*** End Patch",
      }),
    },
    {
      name: "fetch",
      arguments: JSON.stringify({ url: "http://127.0.0.1:1/forbidden" }),
    },
    {
      name: "request_user_input",
      arguments: JSON.stringify({
        questions: [
          {
            id: "fixture",
            header: "fixture",
            question: "Synthetic request",
            options: [
              { label: "One", description: "One" },
              { label: "Two", description: "Two" },
            ],
          },
        ],
      }),
    },
    {
      name: readToolName,
      arguments: JSON.stringify({ attachmentId: "contract-material" }),
    },
  ];
  let direct: boolean | undefined;
  /** Whether the direct-function session offers the skill tools (Codex 0.159 no longer does). */
  let directSkillTools = false;
  const functionOutputs = new Map<string, string>();
  function checkDirectTools(raw: unknown) {
    if (!Array.isArray(raw)) throw error();
    const names: string[] = [];
    for (const item of raw) {
      const tool = record(item);
      if (tool.type === "function" && typeof tool.name === "string")
        names.push(tool.name);
      else if (
        tool.type === "namespace" &&
        tool.name === "skills" &&
        Array.isArray(tool.tools)
      ) {
        for (const member of tool.tools) {
          const entry = record(member);
          if (entry.type !== "function" || typeof entry.name !== "string")
            throw error();
          names.push(`skills.${entry.name}`);
        }
      } else throw error();
    }
    // The skill tools come as a pair or not at all; nothing beyond the read tool is required.
    const skills = ["skills.list", "skills.read"];
    const present = skills.filter((name) => names.includes(name)).length;
    if (
      new Set(names).size !== names.length ||
      !names.includes(readToolName) ||
      present === 1 ||
      names.some(
        (name) =>
          ![readToolName, ...skills, "request_user_input"].includes(name),
      )
    )
      throw error();
    directSkillTools = present === 2;
  }
  /**
   * The parts of a request the model provider receives besides our own scripted calls and their
   * results: no instruction, tool description or message may name the unselected personal skill.
   */
  function checkNoPersonalSkill(body: Record<string, unknown>) {
    const own = [
      "custom_tool_call",
      "custom_tool_call_output",
      "function_call",
      "function_call_output",
    ];
    const exposed = JSON.stringify({
      instructions: body.instructions ?? null,
      tools: body.tools ?? null,
      input: (body.input as unknown[]).filter(
        (raw) => !own.includes(String(record(raw).type)),
      ),
    });
    if (
      exposed.includes(personalSkillName) ||
      exposed.includes("UNSELECTED_SYNTHETIC_SKILL_SECRET")
    )
      throw error();
  }
  const server = createServer((request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/v1/responses" ||
      request.headers.authorization
    ) {
      response.writeHead(403);
      response.end();
      finish(error());
      return;
    }
    let length = 0;
    const parts: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 1024 * 1024) {
        request.destroy();
        finish(error());
      } else parts.push(chunk);
    });
    request.on("error", () => finish(error()));
    request.on("end", () => {
      if (settled) {
        response.writeHead(409);
        response.end();
        return;
      }
      try {
        const body = record(JSON.parse(Buffer.concat(parts).toString("utf8")));
        if (
          body.model !== model ||
          !Array.isArray(body.input) ||
          requests > Math.max(scripts.length, functions.length)
        )
          throw error();
        checkNoPersonalSkill(body);
        const style = Array.isArray(body.tools);
        if (direct !== undefined && direct !== style) throw error();
        direct = style;
        if (direct) checkDirectTools(body.tools);
        for (const raw of body.input) {
          const item = record(raw);
          if (direct && item.type === "function_call_output") {
            if (
              typeof item.call_id !== "string" ||
              !/^fixture-[0-7]$/.test(item.call_id) ||
              typeof item.output !== "string" ||
              item.output.length > 32768 ||
              item.output.includes("UNSELECTED_SYNTHETIC_SKILL_SECRET")
            )
              throw error();
            if (
              functionOutputs.has(item.call_id) &&
              functionOutputs.get(item.call_id) !== item.output
            )
              throw error();
            functionOutputs.set(item.call_id, item.output);
          }
          if (!direct && item.type === "custom_tool_call_output") {
            if (!Array.isArray(item.output)) throw error();
            for (const part of item.output) {
              const text = record(part).text;
              if (typeof text !== "string") continue;
              try {
                const parsed: unknown = JSON.parse(text);
                if (
                  !outputs.some(
                    (old) => JSON.stringify(old) === JSON.stringify(parsed),
                  )
                )
                  outputs.push(parsed);
              } catch {
                /* Protocol timing text is not a result. */
              }
            }
          }
        }
        const index = requests++;
        const item =
          index < (direct ? functions.length : scripts.length)
            ? direct
              ? {
                  id: "call-" + index,
                  type: "function_call",
                  call_id: "fixture-" + index,
                  ...functions[index],
                }
              : {
                  id: "call-" + index,
                  type: "custom_tool_call",
                  call_id: "fixture-" + index,
                  name: "exec",
                  input: scripts[index],
                }
            : {
                id: "message-final",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: "synthetic-complete",
                    annotations: [],
                  },
                ],
              };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [type, data] of [
          [
            "response.created",
            {
              response: {
                id: "response-fixture",
                status: "in_progress",
                output: [],
              },
            },
          ],
          [
            "response.output_item.added",
            {
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            },
          ],
          ["response.output_item.done", { output_index: 0, item }],
          [
            "response.completed",
            {
              response: {
                id: "response-fixture",
                status: "completed",
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ],
        ] as const)
          response.write(
            "event: " +
              type +
              "\ndata: " +
              JSON.stringify({ type, ...data }) +
              "\n\n",
          );
        response.end();
      } catch {
        response.destroy();
        finish(error());
      }
    });
  });
  const timer = setTimeout(() => finish(error()), 20_000);
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(0, "127.0.0.1", yes);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw error();
    const overrides = {
      model,
      model_provider: "csthink_contract",
      "model_providers.csthink_contract": {
        name: "Local synthetic capability check",
        base_url: "http://127.0.0.1:" + address.port + "/v1",
        wire_api: "responses",
        requires_openai_auth: false,
        request_max_retries: 0,
        stream_max_retries: 0,
      },
      "features.enable_request_compression": false,
    };
    const extras = Object.entries(overrides).flatMap(([key, value]) => [
      "-c",
      key + "=" + codexToml(value),
    ]);
    const inspection = new CodexRpc(
      installation.resolvedPath,
      ["app-server", ...extras],
      { cwd, env },
    );
    let inventory;
    try {
      await inspection.request("initialize", {
        clientInfo: { name: "csthink_contract", version: "0.1" },
      });
      inspection.notify("initialized");
      inventory = codexInventory(
        await inspection.request("config/read", { includeLayers: true, cwd }),
      );
    } finally {
      await inspection.close();
    }
    rpc = new CodexRpc(
      installation.resolvedPath,
      [
        ...codexPolicyArgs(installation.resolvedPath, cwd, inventory),
        ...extras,
      ],
      { cwd, env },
    );
    await initializeRestrictedCodex(
      rpc,
      installation.resolvedPath,
      cwd,
      inventory,
    );
    const thread = await startCodexThread(
      rpc,
      cwd,
      model,
      "csthink_contract",
      true,
    );
    if (thread.instructions.length) throw error();
    rpc.setEvents({
      notification(method, params) {
        if (method === "turn/completed") {
          if (record(record(params).turn).status !== "completed")
            finish(error());
          else finish();
        }
      },
      async request(method, raw) {
        const p = record(raw);
        if (
          method !== "item/tool/call" ||
          p.threadId !== thread.id ||
          p.tool !== readToolName ||
          JSON.stringify(p.arguments) !==
            '{"attachmentId":"contract-material"}' ||
          ++callbacks !== 1
        ) {
          finish(error());
          throw error();
        }
        return {
          success: true,
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({ contractMaterialRead: true }),
            },
          ],
        };
      },
      failure: () => finish(error()),
    });
    await rpc.request("turn/start", {
      threadId: thread.id,
      input: [
        { type: "text", text: "Synthetic local runtime capability check." },
      ],
    });
    await done;
    const includes = (value: unknown) =>
      outputs.some((out) => JSON.stringify(out) === JSON.stringify(value));
    // The one script result that lists the tools. Clock availability is model-specific and is not
    // required by our read tool, so only that known harmless optional tool is normalized away. The skill
    // tools are optional as a pair: Codex 0.159 no longer offers them here, and where they are offered
    // they must list nothing. Every other extra or missing tool is rejected.
    const listed = outputs
      .map((out) => record(out))
      .filter((value) => Array.isArray(value.tools));
    const reported = listed.length === 1 ? listed[0] : null;
    const tools = reported?.tools as unknown[] | undefined;
    const named =
      tools && tools.every((tool) => typeof tool === "string")
        ? tools.filter((tool) => tool !== "clock__curr_time").sort()
        : null;
    const skillTools = !!named?.includes("skills__list");
    const expected = {
      tools: (skillTools
        ? [readToolName, "skills__list", "skills__read"]
        : [readToolName]
      ).sort(),
      fetch: "undefined",
      process: "undefined",
      require: "undefined",
    };
    if (
      !direct &&
      (requests !== scripts.length + 1 ||
        callbacks !== 1 ||
        !reported ||
        !tools ||
        !named ||
        new Set(tools).size !== tools.length ||
        JSON.stringify({ ...reported, tools: named }) !==
          JSON.stringify(expected) ||
        (skillTools &&
          !includes({
            orchestrator: { skills: [], warnings: [], next_cursor: null },
            executor: { skills: [], warnings: [], next_cursor: null },
          })) ||
        !includes({ nodeImportDenied: true }) ||
        !includes({ bypassDenied: true }) ||
        !includes({ contractMaterialRead: true }))
    )
      throw error();
    if (direct) {
      const parse = (id: number) =>
        record(JSON.parse(functionOutputs.get(`fixture-${id}`) ?? "null"));
      const emptySkills = { skills: [], warnings: [], next_cursor: null };
      if (
        requests !== functions.length + 1 ||
        callbacks !== 1 ||
        functionOutputs.size !== functions.length ||
        (directSkillTools &&
          (JSON.stringify(parse(0)) !== JSON.stringify(emptySkills) ||
            JSON.stringify(parse(1)) !== JSON.stringify(emptySkills))) ||
        JSON.stringify(parse(7)) !==
          JSON.stringify({ contractMaterialRead: true }) ||
        (directSkillTools ? [2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6]).some(
          (id) =>
            !/unsupported|unknown|not (?:available|found)|unavailable/i.test(
              functionOutputs.get(`fixture-${id}`) ?? "",
            ),
        )
      )
        throw error();
    }
    if (
      await stat(join(cwd, "forbidden-effect")).then(
        () => true,
        () => false,
      )
    )
      throw error();
  } finally {
    clearTimeout(timer);
    try {
      await rpc?.close();
    } finally {
      server.closeAllConnections();
      try {
        await new Promise<void>((yes) => server.close(() => yes()));
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  }
}
