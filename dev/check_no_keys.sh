#!/usr/bin/env bash
# SHADOW-05：推 GitHub 前的 key 检查——对 git 跟踪文件全量扫描 key 赋值形态。
#
# 用法:
#     bash dev/check_no_keys.sh
#
# 扫描口径：对 `git ls-files` 列出的全部跟踪文件逐个 grep 既有 key 泄漏闸同一正则
# （三个 key 变量名 + 赋值号/JSON 冒号 + 引号起头）。命中即列文件行并退出 1；
# 全净打印 ok。新增 key 变量名时改下面 PAT 一行，并同步 notes/private-local-env.md。
#
# 值形状豁免（从紧，2026-09-30 定）：赋值形态的正则没法区分真实 key 与测试占位——
# 本仓跟踪面里的测试夹具本就有大量假 key 赋值（'' 、'k'、'test-key'、'official-key'、
# 'smoke-stub'）。只有满足以下之一的命中行才豁免：
#   1. 引号内提取出的值长度 < 16——真实凭据（Brave / TypeSafe key）不会短于 16 字符；
#   2. 值本身含占位词（test/stub/fake/dummy/example/placeholder/your key/changeme/
#      smoke，不分大小写）。
# 提取不出引号值、或值 >= 16 字符：一律照报，绝不静默放过。真实 key 粘进任何跟踪
# 文件都会因长度过线被报——豁免只放过测试占位，不给真泄漏开后门。
#
# package.json 不加 npm script（避免动上游无关文件）；跑法写进
# notes/test-mode-logging.md 的"发布检查"节，公开前人工跑一次。
set -u

PAT='(jev_API_KEY|TYPESAFE_API_KEY|BRAVE_API_KEY)[[:space:]]*[:=][[:space:]]*["'\'']'
PLACEHOLDER='(test|stub|fake|dummy|example|placeholder|your[-_]?key|changeme|smoke)'
MIN_REAL_KEY_LEN=16

hits=0
while IFS= read -r file; do
  [ -f "$file" ] || continue
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    lineno=${line%%:*}
    content=${line#*:}
    # 提取赋值号后引号内的值（哨兵 <> 区分"提取到空值"与"没提取到"）；
    # 值为测试占位（短于真实 key 长度或含占位词）才豁免
    raw=$(printf '%s\n' "$content" | sed -n "s/.*[:=][[:space:]]*[\"']\([^\"']*\)[\"'].*/<\1>/p")
    if [ -n "$raw" ]; then
      value=${raw#<}
      value=${value%>}
      if [ "${#value}" -lt "$MIN_REAL_KEY_LEN" ] || printf '%s' "$value" | grep -qiE "$PLACEHOLDER"; then
        continue
      fi
    fi
    printf '%s:%s: %s\n' "$file" "$lineno" "$content"
    hits=$((hits + 1))
  done < <(grep -nEI "$PAT" "$file" 2>/dev/null || true)
done < <(git ls-files)

if [ "$hits" -gt 0 ]; then
  echo "FAIL: 检出 $hits 处疑似 key 赋值，公开前必须移除或改走环境变量。" >&2
  exit 1
fi
echo "ok: git 跟踪文件全部干净，无 key 赋值形态。"
