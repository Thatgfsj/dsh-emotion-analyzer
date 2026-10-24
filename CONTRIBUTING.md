# 贡献与仓库规则

本仓库遵循以下硬性工作规则（与维护者的全局约定一致）：

1. **公开、MIT 许可**：代码按照 `LICENSE`（MIT）发布。模型权重不属于本仓库，遵循其上游许可证（CC-BY-NC-4.0），不得提交进仓库。
2. **任何修改都必须先建 Issue，再走 Pull Request**：不允许直接向 `main` 推送。PR 描述中写 `Closes #<issue>`。
3. **CI 只在构建期运行**：`.github/workflows/build.yml` 仅由 `v*` tag 或手动 `workflow_dispatch` 触发；**PR 不跑 CI**。本地合并前请自行运行 `npm run check && npm run build`。
4. **单文件 ≤ 1000 行**：新增/修改的源码文件不得超过 1000 行，超了就拆分。生成产物（`lib/`、`demo/widget.iife.js`）不提交。
5. **分支与本地构建及时清理**：合并后删除远程/本地分支与临时 worktree；不要把 `lib/`、`dist/`、`node_modules/` 或模型产物留在工作区。
6. **文档随代码更新**：API、配置参数、可调常量、安装步骤发生变化时，同一个 PR 内更新 README/docs/CHANGELOG。

## 开发流程

```sh
gh issue create ...            # 1. 新建议题
git switch -c feat/<issue>-x   # 2. 从 main 建分支
npm run check                  # 3. 本地验证（不跑 CI）
git commit -m "feat: ... (#<issue>)"
gh pr create --fill            # 4. 开 PR
gh pr merge --squash --delete-branch
```

## 模型资产

模型 `tabularisai/multilingual-emotion-classification` 的权重为 **CC-BY-NC-4.0**（非商业）。本仓库只包含下载/导出/量化脚本，不随仓库分发权重。
