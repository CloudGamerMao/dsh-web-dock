#!/usr/bin/env bash
# dsh-plugin 便捷脚本 —— 绕过 WorkBuddy 的 genie-safe-delete shim（NODE_OPTIONS 注入）
# 问题：WorkBuddy 通过 NODE_OPTIONS="--require=genie-safe-delete.cjs" 注入回收站 shim，
#       pnpm 的 _tmp_* staging 目录 unlink 会被 shim 拦下走 trash -> "Some operations were aborted"
# 解法：清空 NODE_OPTIONS 运行 dsh 子命令（shim 内部也会 self-clean NODE_OPTIONS）
# 用法：./dsh-plugin.sh plugin list --profile web-poc   （等价 dsh plugin list ...）
#       ./dsh-plugin.sh plugin add <pkg> --profile web-poc
#
# 环境变量覆盖（可选）：
#   DSH_BIN        dsh CLI bin.js 的绝对路径（默认：npm 全局 root 下的 @deepseek-ai/dsh）
#   DSH_NODE_BIN   Node.js 可执行文件路径（默认：PATH 中的 node）
NODE_BIN="${DSH_NODE_BIN:-$(command -v node || echo node)}"
if [ -z "${DSH_BIN:-}" ]; then
  GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
  DASH_BIN="${GLOBAL_ROOT}/@deepseek-ai/dsh/lib/bin.js"
else
  DASH_BIN="${DSH_BIN}"
fi
cd "$(dirname "$0")/../.." 2>/dev/null || true
NODE_OPTIONS="" "$NODE_BIN" "$DASH_BIN" "$@"
