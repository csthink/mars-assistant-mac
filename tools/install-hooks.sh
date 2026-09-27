#!/usr/bin/env bash
#
# 安装本仓的 pre-commit hook（幂等，可重复执行）。
#
#   tools/install-hooks.sh
#
# hook 只有一行转发：对本次暂存的文件调用同目录的 tools/check-public-safety-generic.sh，
# 内容从索引读（--staged），也就是真正要提交的内容。CI 调用的是同一份脚本，判据一致。
# 检查逻辑不拷进 hook：hook 在 .git/ 下、不在版本库里，无法 review 也不随仓分发，所以它必须薄。
# 已存在且不是本安装器生成的 hook 不覆盖，原样报出让人处理。
# hook 可被 git commit --no-verify 绕过，所以 CI 侧必须再检一次。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCANNER="$REPO_ROOT/tools/check-public-safety-generic.sh"
MARK="# check-public-safety-generic pre-commit forwarder"

if [ ! -f "$SCANNER" ]; then
  echo "错误：找不到扫描器 $SCANNER" >&2
  exit 1
fi

# git rev-parse --git-path 在仓内返回相对路径（相对 REPO_ROOT），补成绝对路径再用；它尊重 core.hooksPath。
HOOK_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks)"
case "$HOOK_DIR" in /*) ;; *) HOOK_DIR="$REPO_ROOT/$HOOK_DIR" ;; esac
HOOK="$HOOK_DIR/pre-commit"

if [ -f "$HOOK" ] && ! grep -qF "$MARK" "$HOOK"; then
  echo "已存在未识别的 pre-commit hook：${HOOK}，不覆盖。请人工合并后重跑。" >&2
  exit 1
fi

mkdir -p "$HOOK_DIR"
cat > "$HOOK" <<EOF
#!/usr/bin/env bash
$MARK
# 由 tools/install-hooks.sh 生成，请勿手工修改；检查逻辑在仓内 tools/check-public-safety-generic.sh。
# 只检查本次暂存的文件（含改名后的新路径，不含已删除的路径），内容从索引读；路径按 NUL 读且不转义；兼容 bash 3.2（不用 mapfile）。
set -uo pipefail
root="\$(git rev-parse --show-toplevel)" || exit 1
cd "\$root" || exit 1
files=()
while IFS= read -r -d '' f; do files+=("\$f"); done < <(git -c core.quotePath=false diff --cached --name-only --diff-filter=ACMR -z)
[ "\${#files[@]}" -eq 0 ] && exit 0
exec bash "\$root/tools/check-public-safety-generic.sh" --staged "\$root" "\${files[@]}"
EOF
chmod +x "$HOOK"
echo "已安装 $HOOK"
echo "检查逻辑：$SCANNER"
