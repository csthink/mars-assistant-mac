/**
 * Synthetic model outputs for replay. Reference fixtures submit the hand-written widget of
 * each requirement; variant fixtures submit other correct implementations that must also satisfy
 * every rule; negative fixtures cover every failure class the pipeline distinguishes.
 * Each states the outcome it must produce, so replay doubles as a test of the scoring itself.
 * Durations are fixed synthetic values, not measurements.
 */
import { widgetSubmitToolName } from "../../../src/shared/widget-generation-tool";
import type { WidgetPackage } from "../../../src/shared/widget";
import type { Fixture, ModelResponse, RecordedOutcome } from "./model";
import { references } from "./references";
import type { FailureClass, Stage } from "./score";

export interface Expectation {
  stage: Stage | null;
  failure: FailureClass | null;
  /** Rules that must fail, for requirement_unmet. */
  failedRules?: string[];
}
export interface SyntheticFixture {
  fixture: Fixture;
  expect: Expectation;
}

const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
) => ({
  id: "chatcmpl-synthetic",
  object: "chat.completion.chunk",
  model: "synthetic",
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const events = (list: unknown[]) =>
  list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
  "data: [DONE]\n\n";
/** Splits a string into n roughly equal parts, as a provider streams tool arguments. */
function parts(text: string, n: number) {
  const size = Math.max(1, Math.ceil(text.length / n));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}
interface Stream {
  reasoning?: string;
  text?: string;
  calls?: { name: string; arguments: string }[];
}
export function streamBody(s: Stream): string {
  const list: unknown[] = [chunk({ role: "assistant", content: "" })];
  if (s.reasoning)
    for (const p of parts(s.reasoning, 3))
      list.push(chunk({ reasoning_content: p }));
  if (s.text)
    for (const p of parts(s.text, 3)) list.push(chunk({ content: p }));
  (s.calls ?? []).forEach((call, index) => {
    parts(call.arguments, 4).forEach((p, i) =>
      list.push(
        chunk({
          tool_calls: [
            i === 0
              ? {
                  index,
                  id: `call-${index + 1}`,
                  type: "function",
                  function: { name: call.name, arguments: p },
                }
              : { index, function: { arguments: p } },
          ],
        }),
      ),
    );
  });
  list.push(chunk({}, s.calls?.length ? "tool_calls" : "stop"));
  return events(list);
}
const stream = (s: Stream): ModelResponse => ({
  status: 200,
  contentType: "text/event-stream",
  body: streamBody(s),
});
const submit = (pkg: WidgetPackage | string) => ({
  name: widgetSubmitToolName,
  arguments: JSON.stringify({
    package: typeof pkg === "string" ? pkg : JSON.stringify(pkg),
  }),
});
function fixture(
  id: string,
  requirement: string,
  model: "reference" | "variant" | "negative",
  durationMs: number,
  response: ModelResponse | null,
  outcome: RecordedOutcome = { kind: "response" },
): Fixture {
  return {
    schemaVersion: 1,
    id,
    requirement,
    source: "synthetic",
    provider: "synthetic",
    model,
    repeat: 1,
    recorded: { outcome, durationMs, firstByteMs: null, usage: null },
    response,
  };
}
const pass: Expectation = { stage: null, failure: null };
const fails = (
  stage: Stage,
  failure: FailureClass,
  failedRules?: string[],
): Expectation => ({ stage, failure, ...(failedRules ? { failedRules } : {}) });

const referenceDurations = [
  41_200, 36_800, 52_400, 63_900, 47_300, 58_100, 44_600, 29_700, 61_500,
  49_800, 33_900, 27_400, 45_200,
];
function referenceFixtures(): SyntheticFixture[] {
  return Object.entries(references).map(([requirement, pkg], i) => ({
    fixture: fixture(
      `synthetic.reference.${requirement}`,
      requirement,
      "reference",
      referenceDurations[i],
      stream(
        // Vary the stream shape the way providers do: reasoning, a short preface or neither.
        i % 3 === 0
          ? { reasoning: "Plan the widget layout.", calls: [submit(pkg)] }
          : i % 3 === 1
            ? { text: "Creating the widget.", calls: [submit(pkg)] }
            : { calls: [submit(pkg)] },
      ),
    ),
    expect: pass,
  }));
}

const dice = references["dice-roller-en"];
const bmi = references["form-bmi-en"];
const withView = (
  pkg: WidgetPackage,
  view: Partial<WidgetPackage["view"]>,
) => ({
  ...pkg,
  view: { ...pkg.view, ...view },
});
function negativeFixtures(): SyntheticFixture[] {
  const { draftFields: _drop, ...missingField } = bmi;
  void _drop;
  const list: [
    string,
    string,
    number,
    ModelResponse | null,
    Expectation,
    RecordedOutcome?,
  ][] = [
    [
      "text-only",
      "dice-roller-en",
      18_300,
      stream({
        text: "Here is the widget:\n```html\n<button>Roll</button>\n```",
      }),
      fails("submitted", "no_submission"),
    ],
    [
      "two-submissions",
      "dice-roller-en",
      24_100,
      stream({ calls: [submit(dice), submit(dice)] }),
      fails("submitted", "multiple_submissions"),
    ],
    [
      "undeclared-tool",
      "dice-roller-en",
      21_000,
      stream({
        calls: [{ name: "write_file", arguments: '{"path":"widget.html"}' }],
      }),
      fails("submitted", "wrong_tool"),
    ],
    [
      "arguments-incomplete",
      "dice-roller-en",
      19_600,
      stream({
        calls: [{ name: widgetSubmitToolName, arguments: '{"package": ' }],
      }),
      fails("submitted", "malformed_tool_call"),
    ],
    [
      "arguments-extra-field",
      "dice-roller-en",
      22_800,
      stream({
        calls: [
          {
            name: widgetSubmitToolName,
            arguments: JSON.stringify({
              package: JSON.stringify(dice),
              note: "retained",
            }),
          },
        ],
      }),
      fails("valid", "invalid_arguments"),
    ],
    [
      "package-as-object",
      "dice-roller-en",
      23_400,
      stream({
        calls: [
          {
            name: widgetSubmitToolName,
            arguments: JSON.stringify({ package: dice }),
          },
        ],
      }),
      fails("valid", "invalid_arguments"),
    ],
    [
      "package-not-json",
      "form-bmi-en",
      26_500,
      stream({ calls: [submit("<div>BMI</div>")] }),
      fails("compiled", "compile_rejected"),
    ],
    [
      "package-missing-field",
      "form-bmi-en",
      31_200,
      stream({ calls: [submit(JSON.stringify(missingField))] }),
      fails("compiled", "compile_rejected"),
    ],
    [
      "package-imports",
      "form-bmi-en",
      28_900,
      stream({
        calls: [
          submit(
            withView(bmi, {
              js: 'import confetti from "confetti";\n' + bmi.view.js,
            }),
          ),
        ],
      }),
      fails("compiled", "compile_rejected"),
    ],
    [
      "package-undelivered-capability",
      "form-bmi-en",
      30_400,
      stream({
        calls: [
          submit(
            JSON.stringify({
              ...bmi,
              capabilities: ["network.fetch"],
            }),
          ),
        ],
      }),
      fails("compiled", "compile_rejected"),
    ],
    [
      "runtime-error",
      "form-bmi-en",
      27_700,
      stream({
        calls: [
          submit(
            withView(bmi, {
              js:
                'document.querySelector("#calculate-button").addEventListener("click", () => {});\n' +
                bmi.view.js,
            }),
          ),
        ],
      }),
      fails("rendered", "render_error"),
    ],
    [
      "no-saving",
      "todo-basic-zh",
      39_500,
      stream({
        calls: [
          submit({
            ...references["todo-basic-zh"],
            capabilities: [],
            view: {
              ...references["todo-basic-zh"].view,
              js: references["todo-basic-zh"].view.js
                .replace(
                  /async function save\(\) \{[\s\S]*?\n\}/,
                  "function save() {\n  render();\n}",
                )
                .replace(/const loaded = [\s\S]*?\n\}\n/, ""),
            },
          }),
        ],
      }),
      fails("satisfied", "requirement_unmet", [
        "declares-data-write",
        "writes-data",
      ]),
    ],
    [
      "no-countdown",
      "timer-pomodoro-zh",
      35_100,
      stream({
        calls: [
          submit(
            withView(references["timer-pomodoro-zh"], {
              html: `<main><p id="time">25:00</p><button id="start">开始</button><button id="pause">暂停</button></main>`,
              js: 'document.querySelector("#start").addEventListener("click", () => {});',
            }),
          ),
        ],
      }),
      fails("satisfied", "requirement_unmet", [
        "reset-button",
        "counts-down",
        "reset-restores",
      ]),
    ],
    [
      "rate-limited",
      "world-clock-zh",
      1_200,
      {
        status: 429,
        contentType: "application/json",
        body: '{"error":{"message":"Rate limit reached for requests","type":"rate_limit_exceeded"}}',
      },
      fails("provider", "rate_limit"),
    ],
    [
      "unauthorized",
      "world-clock-zh",
      900,
      {
        status: 401,
        contentType: "application/json",
        body: '{"error":{"message":"Authentication Fails","type":"authentication_error"}}',
      },
      fails("provider", "auth"),
    ],
    [
      "dropped-stream",
      "chart-line-en",
      45_800,
      {
        status: 200,
        contentType: "text/event-stream",
        body: streamBody({
          calls: [submit(references["chart-line-en"])],
        }).slice(0, 900),
        truncated: true,
      },
      fails("provider", "stream"),
    ],
    [
      "waited-out",
      "kanban-board-en",
      600_000,
      null,
      fails("provider", "timeout"),
      { kind: "timeout" },
    ],
  ];
  return list.map(([name, requirement, ms, response, expect, outcome]) => ({
    fixture: fixture(
      `synthetic.negative.${name}`,
      requirement,
      "negative",
      ms,
      response,
      outcome,
    ),
    expect,
  }));
}

/**
 * The contact form written as a form whose submit handler prevents the default action and updates
 * the view in place, the way generated widgets commonly write forms. The widget view runs submit
 * handlers while the submission itself goes nowhere, so this variant satisfies every rule. The form
 * sets novalidate because the handler validates the email itself; without it the browser's own
 * constraint validation stops the submission before the handler runs.
 *
 * The habit grid written the way generated widgets commonly draw checkboxes: each habit's name and
 * its streak share one element, and every native checkbox is visually hidden inside a label whose
 * span draws the box. The name is still visible text and a click on the label checks the box, so
 * this variant satisfies every rule as well.
 */
function variantFixtures(): SyntheticFixture[] {
  const contact = references["form-contact-zh"];
  const habit = references["habit-grid-en"];
  return [
    {
      fixture: fixture(
        "synthetic.variant.form-submit-handler",
        "form-contact-zh",
        "variant",
        33_600,
        stream({
          calls: [
            submit(
              withView(contact, {
                html: contact.view.html
                  .replace("<div>", '<form id="form" novalidate>')
                  .replace(
                    '<button id="submit" type="button">',
                    '<button type="submit">',
                  )
                  .replace("</button></div>", "</button></form>"),
                js: contact.view.js.replace(
                  'document.querySelector("#submit").addEventListener("click", () => {',
                  'document.querySelector("#form").addEventListener("submit", (event) => {\n  event.preventDefault();',
                ),
              }),
            ),
          ],
        }),
      ),
      expect: pass,
    },
    {
      fixture: fixture(
        "synthetic.variant.habit-hidden-checkboxes",
        "habit-grid-en",
        "variant",
        41_200,
        stream({
          calls: [
            submit(
              withView(habit, {
                css:
                  habit.view.css +
                  ".cell{position:relative;display:inline-flex;cursor:pointer}" +
                  ".cell input{position:absolute;width:1px;height:1px;margin:0;opacity:0;pointer-events:none}" +
                  ".cell span{display:inline-block;width:18px;height:18px;border:1px solid currentColor;border-radius:4px}" +
                  ".cell input:checked+span{background:currentColor}",
                js: habit.view.js
                  .replace(
                    "th.textContent = habit;",
                    'th.textContent = habit;\n    const own = document.createElement("div");\n    own.textContent = "Streak: " + streak(cells[h]);\n    th.append(own);',
                  )
                  .replace(
                    "td.append(box);",
                    'const label = document.createElement("label");\n      label.className = "cell";\n      label.append(box, document.createElement("span"));\n      td.append(label);',
                  )
                  .replace(
                    'const s = document.createElement("td");\n    s.textContent = "Streak: " + streak(cells[h]);\n    tr.append(s);\n',
                    "",
                  ),
              }),
            ),
          ],
        }),
      ),
      expect: pass,
    },
  ];
}

export function syntheticFixtures(): SyntheticFixture[] {
  return [...referenceFixtures(), ...variantFixtures(), ...negativeFixtures()];
}
