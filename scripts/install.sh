#!/usr/bin/env bash
# opencode2-kiro-auth 安装脚本（opencode v2）
# 作用：装依赖 -> 构建 -> 把本插件按本地路径注册进 opencode v2 全局配置。
# 幂等：重复运行安全，已有配置会合并而非覆盖。
set -euo pipefail

# ---- 定位仓库根目录（脚本在 scripts/ 下）----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- opencode v2 配置目录（遵循 XDG）----
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
CONFIG_FILE="$CONFIG_DIR/opencode.jsonc"
KIRO_FILE="$CONFIG_DIR/kiro.json"

echo "==> 仓库目录: $REPO_DIR"
echo "==> 配置目录: $CONFIG_DIR"

# ---- 前置检查 ----
if ! command -v node >/dev/null 2>&1; then
  echo "错误：未找到 node，请先安装 Node.js (>=20)。" >&2; exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "警告：建议 Node.js >= 20，当前为 $(node -v)。" >&2
fi
if ! command -v opencode >/dev/null 2>&1; then
  echo "警告：PATH 里没找到 opencode，确认已安装 opencode v2。" >&2
fi

# ---- 装依赖 + 构建 ----
cd "$REPO_DIR"
if [ -f package-lock.json ]; then
  echo "==> npm ci"; npm ci
else
  echo "==> npm install"; npm install
fi
echo "==> npm run build"
npm run build

# ---- 把插件写进 opencode v2 全局配置（用 node 合并，保留已有内容）----
mkdir -p "$CONFIG_DIR"
echo "==> 注册插件到 $CONFIG_FILE"
REPO_DIR="$REPO_DIR" CONFIG_FILE="$CONFIG_FILE" node - <<'NODE'
const fs = require("fs");
const repo = process.env.REPO_DIR;
const file = process.env.CONFIG_FILE;
let cfg = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, "utf8");
  // 容忍 // 和 /* */ 注释的极简清洗；失败则报错让用户手动处理，绝不覆盖
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  try { cfg = JSON.parse(stripped) || {}; }
  catch (e) {
    console.error("无法解析已有的 opencode.jsonc，为避免破坏请手动添加插件路径：");
    console.error("  " + repo);
    process.exit(1);
  }
}
cfg["$schema"] = cfg["$schema"] || "https://opencode.ai/config.json";
const list = Array.isArray(cfg.plugins) ? cfg.plugins : [];
if (!list.includes(repo)) list.unshift(repo);
cfg.plugins = list;
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log("    plugins =", JSON.stringify(cfg.plugins));
NODE

# ---- 检查旧版遗留配置，避免"换个目录就没插件"----
LEGACY_FILE="$HOME/.opencode/opencode.json"
if [ -f "$LEGACY_FILE" ]; then
  echo ""
  echo "⚠️  发现旧版遗留配置: $LEGACY_FILE"
  echo "    opencode v2 会把它和 $CONFIG_FILE 一起加载，两份叠加可能导致"
  echo "    插件在某些目录下加载、某些目录下不加载。本插件只注册进了 v2 配置。"
  echo "    建议删除旧文件只保留一份: rm \"$LEGACY_FILE\""
  echo "    (删前可备份: cp \"$LEGACY_FILE\" \"$LEGACY_FILE.bak\")"
  echo ""
fi

# ---- 可选：代理配置 ----
if [ ! -f "$KIRO_FILE" ]; then
  if [ -n "${KIRO_PROXY_URL:-}" ]; then
    echo "==> 写入代理配置 $KIRO_FILE (proxy_url=$KIRO_PROXY_URL)"
    printf '{\n  "proxy_url": "%s"\n}\n' "$KIRO_PROXY_URL" > "$KIRO_FILE"
  else
    echo "==> 未设置 KIRO_PROXY_URL，跳过代理配置。"
    echo "    若模型报 \"Invalid model\"，在 $KIRO_FILE 里设置 proxy_url。"
  fi
else
  echo "==> $KIRO_FILE 已存在，保持不变。"
fi

echo ""
echo "==> 完成。重启 opencode 后运行 /models 选择 kiro 模型。"
echo "    登录：opencode auth login -> 选 Other -> 输入 kiro；或先 kiro-cli login。"
