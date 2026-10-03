#!/usr/bin/env bash
# 扫描 Git 跟踪文件中的密钥赋值形态，命中时列出位置并失败。
# 用法：bash dev/check_no_keys.sh
# 这是按变量名与值形状匹配的检查；检测名见 PAT，豁免规则在对应分支说明。
# 新增密钥变量时同步更新 PAT 和本地配置说明。
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
    # 按密钥名后的赋值提取同型引号值；<> 区分空值与未提取到值。
    # 单双引号分开配对，允许引号前的 YAML 转义反斜杠。
    raw=$(printf '%s\n' "$content" | sed -nE "s/.*(jev_API_KEY|TYPESAFE_API_KEY|BRAVE_API_KEY)[^:=]*[:=][[:space:]]*\\\\?\"([^\"]*)\".*/<\2>/p")
    if [ -z "$raw" ]; then
      raw=$(printf '%s\n' "$content" | sed -nE "s/.*(jev_API_KEY|TYPESAFE_API_KEY|BRAVE_API_KEY)[^:=]*[:=][[:space:]]*\\\\?'([^']*)'.*/<\2>/p")
    fi
    if [ -n "$raw" ]; then
      value=${raw#<}
      value=${value%>}
      # 豁免 VS Code 的输入变量引用、your 文档占位、短值及限定占位词。
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
