#!/usr/bin/env bash
#
# 公开仓安全性检查（通用版）
#
# 覆盖与部署环境无关、但一旦进公开仓就不可挽回的四类红线，加一道路径门：
#   凭据      带引号的凭据字面量赋值（password、passwd、secret、token、apikey、api_key，不分大小写）
#   私钥      PEM 私钥头
#   云凭据    AKIA、gh?_、github_pat_、glpat-、sk-ant-、xox?-、AIza 形态
#   本机路径  /Users/<名>、/home/<名>
#   内网地址  RFC 1918 三段（10/8、172.16/12、192.168/16）
#   路径门    路径命中仓根 records/、docs/tasks/evidence/、docs/design/evidence/，
#             任意层级 attempts/，以及 playwright*.json、report.json、receipt.json、*.tap；
#             这些是测试记录与证据，不进公开仓。
#
# 本文件是本仓 pre-commit hook 与 CI 共用的唯一实现：改一处即两处生效，判据不会分叉。
# 与具体部署环境相关的模式不写进公开仓，模式本身就会暴露它要拦截的内容。
#
# 用法：
#   tools/check-public-safety-generic.sh [--allowlist <文件>] [--staged] [<目录>] [文件…]
#   tools/check-public-safety-generic.sh --selftest
#
#   <目录> 缺省为当前目录。它是 git 仓时只扫索引：git ls-files 枚举路径做路径门，
#   git grep --cached 读内容；已跟踪与已暂存的文件都在内，未跟踪、被忽略、只改在工作树里
#   的内容都不在内（CI 用这条路径）。<目录> 不是 git 仓时扫其中全部常规文件（.git/ 除外）。
#   给了 [文件…] 时只查这些文件（相对 <目录> 的路径或绝对路径），内容从工作树读；
#   加 --staged 则从索引读，pre-commit hook 用这条路径检查真正要提交的内容。
#   --allowlist 默认是本脚本同目录的 public-safety-allowlist.txt，不存在时没有规则。
#   白名单每行一个扩展正则（bash [[ =~ ]] 语义），对「<相对路径>:<行内容>」整体匹配，
#   命中即放行，用于登记测试用合成凭据；路径门不受白名单影响。
#
# 退出码：0 通过；1 有违规或 --selftest 未通过；2 用法错误。
#
# 改动本脚本前必读：
#   1. 判据是 git 的索引，不是文件系统遍历；不按目录名排除。
#      被忽略的文件不会进仓，报出来是误报；已跟踪的文件一定被扫，不靠 --exclude-dir 那种会漏检的写法。
#   2. 模式一律走 -e，不放进会被词拆的变量：含 / | * 的模式会被 shell 当路径做 glob 展开，
#      结果是什么都没扫到而退出码为 0 的静默失效。
#   3. 改动后必跑 --selftest：只验证「真实仓通过」区分不了「没有违规」与「扫描器坏了」。
#   4. 自测样本在运行时用 printf 拼出来，源码里不出现完整的凭据或路径形态，
#      否则本脚本自身会被自己命中。
#   5. 兼容 macOS 自带的 bash 3.2：不用 mapfile、关联数组；空数组展开写成 ${a[@]+"${a[@]}"}；
#      变量后面紧跟中文时写 ${var}，bash 3.2 会把多字节字符的首字节并进变量名。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "$0")"
TITLE="公开仓安全性检查（通用版）"
DEFAULT_ALLOWLIST="$SCRIPT_DIR/public-safety-allowlist.txt"

CATEGORIES=(凭据 私钥 云凭据 本机路径 内网地址 路径门)

# ── 模式 ──────────────────────────────────────────────────────
# 凭据：名字后允许一个引号（JSON 键）、可选空白、: 或 =，值带引号且至少 8 个字符；
# 值以 $ < { 开头的是占位符（"${DB_PASSWORD}"、"<填这里>"、"{{ secret }}"），不算。
PAT_CREDENTIAL='(password|passwd|secret|token|apikey|api_key)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"'$<{][^"'"'"']{7,}'
PAT_PRIVATE_KEY='BEGIN [A-Z ]*PRIVATE KEY'
PAT_CLOUD='AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}'
# 本机路径：前面不能是字母数字，避免把 URL 里的 …com/home/page 当成家目录。
PAT_LOCAL_PATH='(^|[^A-Za-z0-9_])/(Users|home)/[A-Za-z0-9._-]+'
PAT_PRIVATE_NET='(^|[^0-9.])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})([^0-9.]|$)'
PAT_PATH_GATE='^records/|^docs/tasks/evidence/|^docs/design/evidence/|(^|/)attempts/|(^|/)playwright[^/]*\.json$|(^|/)report\.json$|(^|/)receipt\.json$|\.tap$'

usage() {
  cat >&2 <<EOF
用法：
  $0 [--allowlist <文件>] [--staged] [<目录>] [文件…]
  $0 --selftest
EOF
}

# ── 报告 ──────────────────────────────────────────────────────
VIOLATIONS=0
ALLOWED_COUNT=0
HIT_COUNTS=()
for _c in "${CATEGORIES[@]}"; do HIT_COUNTS+=(0); done
if [ -t 1 ]; then RED=$'\033[31m'; RESET=$'\033[0m'; else RED=""; RESET=""; fi

bump() {
  local i
  for i in "${!CATEGORIES[@]}"; do
    if [ "${CATEGORIES[$i]}" = "$1" ]; then HIT_COUNTS[$i]=$(( HIT_COUNTS[$i] + 1 )); return; fi
  done
}

report() {  # 类别 文件 行号 文本（路径门时行号与文本为空）
  local category="$1" file="$2" line="$3" text="$4"
  if [ -n "$line" ]; then
    printf '%s[%s]%s %s:%s\n        %s\n' "$RED" "$category" "$RESET" "$file" "$line" "${text:0:160}"
  else
    printf '%s[%s]%s %s\n' "$RED" "$category" "$RESET" "$file"
  fi
  bump "$category"
  VIOLATIONS=$((VIOLATIONS + 1))
}

# ── 白名单 ────────────────────────────────────────────────────
ALLOW_RULES=()
load_allowlist() {
  local f="$1" line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    ALLOW_RULES+=("$line")
  done < "$f"
}

allowed() {  # $1 = 相对路径:行内容
  local r
  for r in ${ALLOW_RULES[@]+"${ALLOW_RULES[@]}"}; do
    [[ $1 =~ $r ]] && return 0
  done
  return 1
}

# ── 扫描 ──────────────────────────────────────────────────────
MODE=""            # index | staged | worktree | fs
GATE_FILES=()      # 参与路径门的路径（相对 <目录>）
CONTENT_FILES=()   # worktree 与 fs 模式下参与内容扫描的文件

handle_matches() {  # 类别 grep 输出
  local category="$1" matches="$2" m file rest line text
  [ -z "$matches" ] && return 0
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    file=${m%%:*}; rest=${m#*:}; line=${rest%%:*}; text=${rest#*:}
    if allowed "$file:$text"; then ALLOWED_COUNT=$((ALLOWED_COUNT + 1)); continue; fi
    report "$category" "$file" "$line" "$text"
  done <<< "$matches"
}

grep_content() {  # 模式 [grep 额外选项…]；按 MODE 选取内容来源，输出 文件:行号:文本；git grep 带 -c core.quotePath=false，非 ASCII 路径原样输出，白名单才对得上
  local pattern="$1"; shift
  case "$MODE" in
    index)
      git -c core.quotePath=false grep --cached -nIE --no-color "$@" -e "$pattern" 2>/dev/null || true ;;
    staged)
      git -c core.quotePath=false --literal-pathspecs grep --cached -nIE --no-color "$@" -e "$pattern" -- ${GATE_FILES[@]+"${GATE_FILES[@]}"} 2>/dev/null || true ;;
    *)
      [ "${#CONTENT_FILES[@]}" -eq 0 ] && return 0
      printf '%s\0' "${CONTENT_FILES[@]}" \
        | xargs -0 grep -HnIE --binary-files=without-match --color=never "$@" -e "$pattern" -- 2>/dev/null || true ;;
  esac
}

scan() {  # 类别 模式 [grep 额外选项…]
  local category="$1" pattern="$2"; shift 2
  handle_matches "$category" "$(grep_content "$pattern" "$@")"
}

gate() {
  local f
  for f in ${GATE_FILES[@]+"${GATE_FILES[@]}"}; do
    [[ $f =~ $PAT_PATH_GATE ]] && report "路径门" "$f" "" ""
  done
  return 0
}

summary() {
  local parts="" i
  for i in "${!CATEGORIES[@]}"; do
    [ "${HIT_COUNTS[$i]}" -gt 0 ] && parts="$parts${parts:+、}${CATEGORIES[$i]} ${HIT_COUNTS[$i]}"
  done
  echo
  [ "$ALLOWED_COUNT" -gt 0 ] && echo "白名单放行 $ALLOWED_COUNT 处（${ALLOWLIST}）"
  if [ "$VIOLATIONS" -eq 0 ]; then
    echo "✅ 通过：未发现违规内容"
    return 0
  fi
  echo "❌ 未通过：共 $VIOLATIONS 处（${parts}）"
  cat <<'EOF'
处理方式：
  · 本机路径、内网地址：改成占位符或环境变量
  · 路径门命中的文件：测试记录与证据不进本仓，移出后再提交
  · 凭据与私钥：立即吊销，再改写历史；只删文件不够，内容仍留在 git 历史里
  · 测试用合成凭据：登记到 tools/public-safety-allowlist.txt，规则带路径前缀限定范围
EOF
  return 1
}

# ── 自测（阳性对照）──────────────────────────────────────────
selftest() {
  local root failed=0 n=0 out rc hits rel dir
  local rc_untracked rc_tracked rc_staged rc_worktree
  # 若本脚本在 git hook 里被调用，环境里会有 GIT_DIR 等变量，会把临时仓的 git 操作导向真实仓。
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR
  root=$(mktemp -d "${TMPDIR:-/tmp}/public-safety-selftest.XXXXXX") || { echo "自测：无法创建临时目录" >&2; return 2; }
  # trap 在函数返回后才执行，局部变量那时已不存在，所以清理路径放在全局变量里。
  SELFTEST_ROOT="$root"
  trap 'rm -rf "$SELFTEST_ROOT"' EXIT
  echo "==> ${TITLE}：自测"

  # 每类一个阳性样本，各自放在单独目录里扫描：断言退出码 1、输出含本类标签、不含其他类标签。
  positive() {  # 类别 相对文件名 内容
    local category="$1" rel="$2" body="$3" dir out rc other
    dir="$root/positive-$n"; n=$((n + 1))
    mkdir -p "$dir/$(dirname "$rel")"
    printf '%s\n' "$body" > "$dir/$rel"
    out=$(bash "$SCRIPT_PATH" --allowlist /dev/null "$dir" 2>&1); rc=$?
    if [ "$rc" -ne 1 ] || ! printf '%s\n' "$out" | grep -qF "[$category]"; then
      echo "  ✗ 阳性对照 ${category}：未命中（退出码 ${rc}）"; failed=1; return
    fi
    for other in "${CATEGORIES[@]}"; do
      [ "$other" = "$category" ] && continue
      if printf '%s\n' "$out" | grep -qF "[$other]"; then
        echo "  ✗ 阳性对照 ${category}：误报为 $other"; failed=1; return
      fi
    done
    echo "  ✓ 阳性对照 ${category}：命中"
  }

  positive "凭据"     "config.yml" "$(printf 'db_password: "%s"' 'synthetic-value-0001')"
  positive "私钥"     "key.pem"    "$(printf -- '-----BEGIN %s PRIVATE KEY-----' RSA)"
  positive "云凭据"   "env.txt"    "$(printf 'AWS_KEY=AKIA%s' 'EXAMPLEEXAMPLE12')"
  positive "本机路径" "notes.md"   "$(printf 'see /Users/%s/notes.md' example)"
  positive "内网地址" "db.conf"    "$(printf 'host = 10.%s' '20.30.40')"

  dir="$root/positive-gate"
  for rel in records/a.md docs/tasks/evidence/b.md docs/design/evidence/c.md runs/attempts/d.txt \
             out/playwright-report.json out/report.json out/receipt.json out/run.tap; do
    mkdir -p "$dir/$(dirname "$rel")"; printf 'clean\n' > "$dir/$rel"
  done
  out=$(bash "$SCRIPT_PATH" --allowlist /dev/null "$dir" 2>&1); rc=$?
  hits=$(printf '%s\n' "$out" | grep -cF '[路径门]')
  if [ "$rc" -eq 1 ] && [ "$hits" -eq 8 ]; then
    echo "  ✓ 阳性对照 路径门：8 条规则各命中 1 处"
  else
    echo "  ✗ 阳性对照 路径门：命中 ${hits}/8（退出码 ${rc}）"; failed=1
  fi

  # 干净样本：占位符、回环地址、三段版本号、URL 里的 /home/、家目录写法。
  dir="$root/negative"; mkdir -p "$dir/src"
  cat > "$dir/src/notes.md" <<'EOF'
"token": "<paste-your-token>"
loopback 127.0.0.1, version 10.0.0, docs at https://example.com/home/page
the /home/ directory, ~/Library/Application Support/app/
EOF
  printf 'db_password: "%s"\n' '${DB_PASSWORD}' >> "$dir/src/notes.md"
  out=$(bash "$SCRIPT_PATH" --allowlist /dev/null "$dir" 2>&1); rc=$?
  if [ "$rc" -eq 0 ]; then echo "  ✓ 阴性对照 干净样本：通过"; else echo "  ✗ 阴性对照 干净样本：被误报（退出码 ${rc}）"; printf '%s\n' "$out" | sed 's/^/      /'; failed=1; fi

  # 索引判据：未跟踪不报；git add 后报；工作树清理后 --staged 仍读索引而报，文件模式读工作树则通过。
  dir="$root/git-mode"; mkdir -p "$dir"
  if git -C "$dir" init -q 2>/dev/null; then
    printf 'db_password: "%s"\n' 'synthetic-value-0002' > "$dir/probe.txt"
    bash "$SCRIPT_PATH" --allowlist /dev/null "$dir" >/dev/null 2>&1; rc_untracked=$?
    git -C "$dir" add -f probe.txt
    bash "$SCRIPT_PATH" --allowlist /dev/null "$dir" >/dev/null 2>&1; rc_tracked=$?
    printf 'clean\n' > "$dir/probe.txt"
    bash "$SCRIPT_PATH" --allowlist /dev/null --staged "$dir" probe.txt >/dev/null 2>&1; rc_staged=$?
    bash "$SCRIPT_PATH" --allowlist /dev/null "$dir" probe.txt >/dev/null 2>&1; rc_worktree=$?
    if [ "$rc_untracked" -eq 0 ] && [ "$rc_tracked" -eq 1 ] && [ "$rc_staged" -eq 1 ] && [ "$rc_worktree" -eq 0 ]; then
      echo "  ✓ 索引判据：未跟踪不报、已暂存报、--staged 读索引、文件模式读工作树"
    else
      echo "  ✗ 索引判据：未跟踪 ${rc_untracked}（期望 0）、已暂存 ${rc_tracked}（期望 1）、--staged ${rc_staged}（期望 1）、文件模式 ${rc_worktree}（期望 0）"; failed=1
    fi
  else
    echo "  ✗ 索引判据：git init 失败"; failed=1
  fi

  echo
  if [ "$failed" -eq 0 ]; then
    echo "✅ 自测通过：${#CATEGORIES[@]} 类阳性对照命中，干净样本通过，索引判据生效"
    return 0
  fi
  echo "❌ 自测未通过：扫描器已失效，修好前不要相信它的「通过」"
  return 1
}

# ── 参数 ──────────────────────────────────────────────────────
ALLOWLIST="$DEFAULT_ALLOWLIST"; ALLOWLIST_EXPLICIT=0; STAGED=0; SELFTEST=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allowlist)
      [ "$#" -ge 2 ] || { echo "用法错误：--allowlist 缺参数" >&2; usage; exit 2; }
      ALLOWLIST="$2"; ALLOWLIST_EXPLICIT=1; shift 2 ;;
    --staged) STAGED=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) echo "用法错误：未知选项 $1" >&2; usage; exit 2 ;;
    *) break ;;
  esac
done

if [ "$SELFTEST" -eq 1 ]; then
  selftest
  exit $?
fi

TARGET="${1:-.}"
[ "$#" -gt 0 ] && shift
[ -d "$TARGET" ] || { echo "用法错误：目录不存在：$TARGET" >&2; exit 2; }
if [ "$ALLOWLIST_EXPLICIT" -eq 1 ] && [ ! -r "$ALLOWLIST" ]; then
  echo "用法错误：白名单不可读：$ALLOWLIST" >&2; exit 2
fi
case "$ALLOWLIST" in /*) ;; *) ALLOWLIST="$PWD/$ALLOWLIST" ;; esac
[ -r "$ALLOWLIST" ] && load_allowlist "$ALLOWLIST"

cd "$TARGET" || { echo "用法错误：无法进入目录：$TARGET" >&2; exit 2; }
IN_GIT=0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 && IN_GIT=1
if [ "$STAGED" -eq 1 ] && [ "$IN_GIT" -eq 0 ]; then
  echo "用法错误：--staged 只能用于 git 仓：$TARGET" >&2; exit 2
fi

if [ "$#" -gt 0 ]; then
  for f in "$@"; do
    rel="$f"
    case "$rel" in
      /*)
        if [ "$rel" = "${rel#"$PWD"/}" ]; then
          echo "用法错误：文件不在 <目录> 之内：$f" >&2; exit 2
        fi
        rel="${rel#"$PWD"/}" ;;
      ./*) rel="${rel#./}" ;;
    esac
    if [ "$STAGED" -eq 1 ]; then
      git --literal-pathspecs ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 \
        || { echo "用法错误：不在索引里：$f" >&2; exit 2; }
    else
      [ -f "$rel" ] || { echo "用法错误：不是已存在的文件：$f" >&2; exit 2; }
      CONTENT_FILES+=("$rel")
    fi
    GATE_FILES+=("$rel")
  done
  if [ "$STAGED" -eq 1 ]; then MODE=staged; MODE_DESC="${#GATE_FILES[@]} 个指定文件，索引内容"
  else MODE=worktree; MODE_DESC="${#GATE_FILES[@]} 个指定文件，工作树内容"; fi
elif [ "$IN_GIT" -eq 1 ]; then
  MODE=index
  while IFS= read -r -d '' f; do GATE_FILES+=("$f"); done < <(git ls-files -z)
  MODE_DESC="git 索引，${#GATE_FILES[@]} 个路径"
else
  MODE=fs
  while IFS= read -r -d '' f; do f="${f#./}"; GATE_FILES+=("$f"); CONTENT_FILES+=("$f"); done \
    < <(find . -type f -not -path './.git/*' -print0)
  MODE_DESC="非 git 目录，${#GATE_FILES[@]} 个常规文件"
fi

echo "==> ${TITLE}：${TARGET}（${MODE_DESC}）"
gate
scan "凭据" "$PAT_CREDENTIAL" -i
scan "私钥" "$PAT_PRIVATE_KEY"
scan "云凭据" "$PAT_CLOUD"
scan "本机路径" "$PAT_LOCAL_PATH"
scan "内网地址" "$PAT_PRIVATE_NET"
summary
