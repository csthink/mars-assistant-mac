# 控件生成评测

把控件「一句话生成」做成可复跑的评测：一组版本化的标准需求，经过与客户端相同的生成路径，按提供方与模型统计每个阶段的通过率、耗时与失败分类。

## 评测对象与路径

每次尝试都走产品自己的生成路径，评测只在外围观察，不另做判定：

1. 业务服务 `Store`（临时数据根）建立草稿与生成任务（`submitWidgetGeneration`）。
2. 主进程执行器 `WidgetGenerationRunner`：等待时限、进展、固定工具 `submit_widget_candidate` 的接收（`validWidgetSubmission` 与 `compileWidget`）、候选写回。
3. API 连接的执行 `runApiWidgetGeneration`，经 `streamChat` 解析提供方的流式响应，与客户端对 API 连接的分派相同。
4. 编译通过的候选在后台客户端里打开，按需求的渲染规则判定。

## 标准需求集

`requirements.json`：13 条，中文 7 条、英文 6 条；计时、待办、图表、表单、数据读写、展示、交互、配置八类；难度 1 至 3。需求原文写明要检查的按钮与标签文字，规则因此可以机械判定。规则分两类：

| 类别 | 检查                                                                                                    | 在哪里判定                   |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 静态 | `capability`（声明的能力）、`source`（视图源码中出现或不出现的模式）、`config`（配置字段类型）          | 编译后的控件包，不需要客户端 |
| 渲染 | `role`（可访问角色与名称）、`text`（可见文字）、`selector`、`interaction`（填写、点击、勾选后检查结果） | 后台客户端中的控件视图       |

`references.ts` 是每条需求的手写参考实现，必须满足自己需求的全部规则，证明规则可以满足；它们不是模型输出。

## 阶段与指标

一次尝试按阶段判定，第一个失败的阶段决定它唯一的失败分类：

| 阶段      | 通过条件                                 | 失败分类                                                                                           |
| --------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| provider  | 提供方返回了响应                         | `timeout`、`stopped`、`network`、`stream`、`auth`、`rate_limit`、`provider` 等（执行器的错误分类） |
| submitted | 恰有一个 `submit_widget_candidate` 调用  | `no_submission`、`multiple_submissions`、`wrong_tool`、`malformed_tool_call`                       |
| valid     | 工具参数通过 `validWidgetSubmission`     | `invalid_arguments`                                                                                |
| compiled  | 编译通过且服务接受候选                   | `compile_rejected`                                                                                 |
| rendered  | 视图出现、有内容、观察期内没有控制台错误 | `render_error`                                                                                     |
| satisfied | 静态规则与渲染规则全部通过               | `requirement_unmet`                                                                                |

按提供方与模型分组输出：每个阶段的通过数、占全部尝试的比例与占上一阶段的比例；耗时的最小值、p50、p90（最近秩法）、最大值与平均值；超时率；失败分类计数。渲染前先打开一个最小基线控件，它的控制台错误来自视图文档本身，不计入候选。

## 回放

夹具是提供方原样的 HTTP 响应（流式响应或错误正文）。回放时本地服务把这些字节交给产品执行器，由产品自己解析；同一组夹具两次运行的 `result.json` 与 `summary.md` 逐字节一致，耗时取自夹具记录，不测本机。`fixtures.ts` 中的合成夹具覆盖每条需求的参考实现与每一种失败分类，并声明各自应得的结果，所以回放同时检验评分逻辑本身；合成夹具的数字不代表任何模型。

```bash
npm run eval:widget -- --out <新目录>                         # 合成夹具，只判静态规则
npm run eval:widget -- --out <新目录> --fixtures <录制夹具目录> # 录制夹具
npx playwright test --project=desktop tests/desktop/widget-eval.spec.ts   # 含渲染；CSTHINK_WIDGET_EVAL_OUT 保存结果
```

服务层测试 `tests/desktop/widget-eval.test.ts` 覆盖阶段判定、规则、统计、确定性与真实调用入口的授权校验，在 CI 中运行。

## 真实调用

`tests/desktop/real-widget-eval.spec.ts` 只在 `CSTHINK_REAL_CALLS_AUTHORIZED=1` 且 `CSTHINK_WIDGET_EVAL_AUTHORIZATION` 指向完整授权文件时运行，否则在发出任何请求前以 NOT RUN 停止。授权文件写明提供方、地址、模型、密钥所在的环境变量名、需求、重复次数、等待时限（5 至 30 分钟）与精确的调用总数；每次尝试只发一次请求，失败不自动重试。执行器与提供方之间的本地转发只记录响应，不记录请求头，密钥从记录中去除；每次尝试都写成可回放的录制夹具，运行结束时逐个回放核对与真实判定一致。
