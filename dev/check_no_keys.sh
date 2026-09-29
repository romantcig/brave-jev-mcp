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
# 值形状豁免（从紧，2026-09-30 定；2026-09-30 审查 WR-01 收紧）：
# 本仓跟踪面里的测试夹具本就有大量假 key 赋值（'' 、'k'、'test-key'、'official-key'、
# 'smoke-stub'）。只有满足以下之一的命中行才豁免：
#   1. 锚定 key 名后提取的同型引号值长度 < 16——真实凭据（Brave / TypeSafe key）不会
#      短于 16 字符；
#   2. 值本身含占位词（test/stub/fake/dummy/example/placeholder/your key/
#      your API key/changeme/smoke，不分大小写，词边界匹配——latest 这类意外子串不再
#      豁免）；VS Code 配置的 ${input:...} 变量引用一并豁免。
# 提取（2026-09-30 WR-01 修复）：双引号值与单引号值分开配对（同型引号才成对——值内嵌
# 撇号不再把提取截断成短前缀）；提取锚定 key 名，取 key 后第一对引号，行内靠后的其他
# 引号赋值不再截胡；等号/冒号与引号间允许 YAML 转义反斜杠。JSON 引号键与无引号 .env
# 值形态均进扫描。无引号裸值：process.env 引用、或短于 24 字符的纯标识符（变量引用，
# 如 FAKE_JEV_KEY / savedKey——真实 key 不短于 32 且不是变量名）豁免；其余裸值
# （含提取失败）一律照报。
# 提取不出引号值、或值 >= 16 字符：一律照报，绝不静默放过。真实 key 粘进任何跟踪
# 文件都会被报——豁免只放过测试占位与变量引用，不给真泄漏开后门。
#
# package.json 不加 npm script（避免动上游无关文件）；跑法写进
# notes/test-mode-logging.md 的"发布检查"节，公开前人工跑一次。
set -u

PAT='["'\'']?(jev_API_KEY|TYPESAFE_API_KEY|BRAVE_API_KEY)["'\'']?[[:space:]]*[:=][[:space:]]*'
PLACEHOLDER='\b(test|stub|fake|dummy|example|placeholder|your[-_]?key|changeme|smoke)\b'
MIN_REAL_KEY_LEN=16
MAX_IDENT_LEN=24

hits=0
while IFS= read -r file; do
  [ -f "$file" ] || continue
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    lineno=${line%%:*}
    content=${line#*:}
    # 提取锚定 key 名后的值（哨兵 <> 区分"提取到空值"与"没提取到"）：双引号值与单引号值
    # 分开配对（同型引号才成对，值内嵌撇号不再截断），取 key 后第一对引号——行内靠后的
    # 其他引号赋值不再截胡；等号与引号间允许 YAML 转义反斜杠（"KEY=\"XXXX\"" 形态）
    raw=$(printf '%s\n' "$content" | sed -nE "s/.*(jev_API_KEY|TYPESAFE_API_KEY|BRAVE_API_KEY)[^:=]*[:=][[:space:]]*\\\\?\"([^\"]*)\".*/<\2>/p")
    if [ -z "$raw" ]; then
      raw=$(printf '%s\n' "$content" | sed -nE "s/.*(jev_API_KEY|TYPESAFE_API_KEY|BRAVE_API_KEY)[^:=]*[:=][[:space:]]*\\\\?'([^']*)'.*/<\2>/p")
    fi
    if [ -n "$raw" ]; then
      value=${raw#<}
      value=${value%>}
      # VS Code 配置的 ${input:...} 变量引用、your 开头的文档占位（YOUR_API_KEY_HERE /
      # your-key——真实 key 是随机串，不会以 your 开头）均豁免
      case "$value" in
        *'$'{input:*) continue ;;
      esac
      if printf '%s' "$value" | grep -qiE '\byour([-_][a-z0-9]+)*'; then
        continue
      fi
      if [ "${#value}" -lt "$MIN_REAL_KEY_LEN" ] || printf '%s' "$value" | grep -qiE "$PLACEHOLDER"; then
        continue
      fi
    else
      # 无引号裸值：process.env 引用、或短纯标识符（变量引用）豁免；其余（含提取失败）照报
      bare=$(printf '%s\n' "$content" | sed -nE "s/.*(jev_API_KEY|TYPESAFE_API_KEY|BRAVE_API_KEY)[^:=]*[:=][[:space:]]*([^[:space:]\"',;)\}]+).*/<\2>/p")
      if [ -n "$bare" ]; then
        bareval=${bare#<}
        bareval=${bareval%>}
        case "$bareval" in
          process.env*|process\.env*) continue ;;
        esac
        if [ "${#bareval}" -lt "$MAX_IDENT_LEN" ] && printf '%s' "$bareval" | grep -qE '^[A-Za-z_$][A-Za-z0-9_$]*$'; then
          continue
        fi
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
