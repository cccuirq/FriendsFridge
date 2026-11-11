# Photo Recognition：推送分支并合并 main

当前开发分支：`kaiyue/photo-recognition`。远程仓库：`git@github.com:cccuirq/FriendsFridge.git`。
以下命令由你执行；开发过程中未自动 commit、push 或 merge。

## 1. 检查并提交本地代码

在 PowerShell 中执行：

```powershell
cd D:\FriendsFridge
git switch kaiyue/photo-recognition
git status --short
git diff --check
git add .
git diff --cached --stat
git diff --cached --name-only
```

检查暂存清单只有这次准备提交的代码和文档；如果混入其他组员尚未完成的修改，用 `git restore --staged -- 路径` 取消暂存（保留文件内容）。确认后提交：

```powershell
git commit -m "Add photo recognition with YOLO-World Large and inventory confirmation"
```

`.gitignore` 已排除 `.venv/`、`.local/`、模型 `*.pt`、Python 缓存及 `.env`。不要使用 `git add -f` 添加它们；`.env.example` 是可提交的配置模板。组员拉取后要自己运行模型准备脚本下载权重。

## 2. 同步 main、验证并推送你的分支

```powershell
git fetch origin
git merge origin/main
```

如果出现冲突，先停止后续步骤。查看 `git status`，逐个保留双方需要的修改、删除冲突标记，再用 `git add 冲突文件路径` 和 `git commit` 完成合并。不要直接覆盖其他组员文件。可以用 `git merge --abort` 退出这次合并后再协商。

合并成功后：

```powershell
npm ci
node --test --test-concurrency=1
.\.venv\Scripts\python.exe -m pytest services\recognition -q
git push -u origin kaiyue/photo-recognition
```

第一次推送需要当前 GitHub 账号对仓库有写权限，并已配置该账号的 SSH key。遇到 `Permission denied (publickey)` 时，先检查 GitHub SSH 配置；不要强制推送到 main。

## 3. 在 GitHub 上合并到 main

打开 [FriendsFridge Pull requests](https://github.com/cccuirq/FriendsFridge/pulls)，选择 **New pull request**：

- **base: main**
- **compare: kaiyue/photo-recognition**

检查 Files changed，创建 PR；让组员检查共享库存接口及词典单位。检查通过、有合并权限且满足分支规则后，点击 **Merge pull request** 或仓库允许的 **Squash and merge**，再确认合并。

建议 PR 标题：`Add Photo Recognition prototype with YOLO-World Large`。

描述应包含：真实图片上传与推理、人工确认、复用 inventory_items、事务批次去重、204 类候选与已知误识别、测试结果，以及组员需安装 Python 依赖并运行 `setup_model.py`。不要把候选数量写成准确识别率。

## 4. 将合并结果拉到本地 main

确认 PR 已在 GitHub 合并后执行：

```powershell
git switch main
git pull --ff-only origin main
```

`push` 是上传分支；PR 的 **merge** 是把功能并入远程 main；最后的 `pull` 是下载已经合并的 main。若本地有未提交修改或 main 已产生分叉，先检查状态，不要使用强制重置丢掉代码。

组员安装与运行见 [Photo Recognition 运行说明](photo-recognition.md)。识别服务使用 Large 权重；运行时不上传照片到第三方。
