# Photo Recognition：运行与小组交接

本模块在现有 Friend’s Fridge 内运行，不是独立网站。当前包含真实 YOLO-World 推理、人工确认以及真实 MongoDB 库存写入。没有运行时模拟识别或模拟库存开关。

## 1. 现有架构与实现边界

- 前端：原生 HTML/CSS、JavaScript ES modules，`public/app.js` 用 URL hash 切换页面。
- 后端：Node.js 22+ 的 `node:http`，没有 Express；`src/app.js` 显式列出可服务的静态文件。
- 数据库：MongoDB 官方驱动、严格 collection validators、UUID 字符串、单节点 replica set 支持事务。
- 登录：HttpOnly / SameSite=Strict cookie，服务端会话认证。新增接口复用已有认证与跨来源检查。
- 已有功能：账号与个人资料、好友邀请、共享库存查看、实时消息、食材请求与交接扣库存、食谱推荐/创建/收藏/分享。
- 开发前 `My Fridge` 只有 Coming soon，个人库存增删改 API 尚未实现；仓库没有上传或 AI 代码。
- 本次只补充库存读取和批量添加适配器、My Fridge 只读列表。完整编辑、删除、共享权限设置仍交给 Inventory 组员。

## 2. 首次安装（Windows PowerShell）

已实测 Windows、Node.js 24.19.0、Python 3.11.10、CPU。建议使用 Python 3.11 独立环境。

```powershell
cd D:\FriendsFridge
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services\recognition\requirements.txt
.\.venv\Scripts\python.exe services\recognition\setup_model.py
```

如 `python` 不可用，先安装 Python 3.11；安装了 Python Launcher 的电脑也可用 `py -3.11 -m venv .venv`。不必激活虚拟环境，因此不需要修改 PowerShell 执行策略。安装过程可能需要数分钟和较大的下载空间：PyTorch、首次 MongoDB 下载及约 338 MiB 的 CLIP 编码器均需下载。

`setup_model.py` 默认从 Ultralytics 官方 release 下载 `yolov8l-worldv2.pt`，用 CLIP 编码共享清单中的 204 类，然后保存离线词汇模型 `services/recognition/.cache/ingredients-worldv2-l.pt`。正常启动不下载权重、不加载 CLIP 编码器；清单与权重不匹配时明确报错，防止标签错位。修改 `shared/recognition-ingredients.json` 后重新运行准备脚本、`npm run db:seed` 并重启 Python 和 Node 服务。

慢速电脑可以运行 `setup_model.py --size s`，然后设置 `$env:YOLO_MODEL_PATH="D:\FriendsFridge\services\recognition\.cache\ingredients-worldv2-s.pt"`。本次 demo 使用 Large（离线词汇权重约 94.5 MB）：在同批混合果蔬照片中恢复了葡萄检测，但甜椒/番茄互相误标，大蒜、肉类等仍不可靠；没有整体准确率提升的结论。可使用 `--size m` 准备 medium，再把 `YOLO_MODEL_PATH` 指向对应的 `ingredients-worldv2-m.pt`。

模型及 `.venv`、测试照片、上传测试输出不应提交到 Git，已配置忽略规则。准备脚本使用 `truststore` 的系统证书，保持 HTTPS 验证；不要通过关闭证书校验解决下载问题。`setuptools==80.9.0` 是为了兼容 CLIP 的 `pkg_resources` 导入。

## 3. 每次运行：三个终端

所有终端都在 `D:\FriendsFridge`。

**终端 A：MongoDB**

```powershell
npm run db:local
```

这个原有命令会启动本机 MongoDB replica set，自动初始化并补齐 206 个食材词典项（204 类视觉候选和 2 个原有词典项）和示例食谱，数据保存在 `.local/mongodb/`。不要与其他占用 27017 端口的 MongoDB 同时启动。

**终端 B：Python 模型服务**

```powershell
.\.venv\Scripts\python.exe -m uvicorn app:app --app-dir services/recognition --host 127.0.0.1 --port 8001
```

只使用一个 worker。等待 `Application startup complete`，再访问 `http://127.0.0.1:8001/health`；`status: ready` 才表示模型已就绪。如果模型加载失败，服务仍启动，但 health 返回 503，识别返回清晰错误。

**终端 C：现有 Web App**

```powershell
npm start
```

打开 <http://127.0.0.1:3000/#recognition>，登录后操作。没有账号时使用现有注册页面。停止任一终端用 Ctrl+C。

默认配置不需要 `.env`。已有 MongoDB/Atlas 的使用者沿用原项目数据库指南，运行 `npm run db:init`、`npm run db:seed`。已有 `.env` 请不要覆盖；可以追加 `RECOGNITION_URL=http://127.0.0.1:8001`。Python 的可选环境变量为 `YOLO_DEVICE`（默认 `cpu`）、`YOLO_MODEL_PATH`（默认离线词汇模型路径）；本次未验证 CUDA。

## 4. 操作流程

页面已移除类别说明区。候选清单保存在 `shared/recognition-ingredients.json`，仍用于模型与库存映射。当前推理阈值 0.45，输入尺寸 640，跨类别抑制重叠框；包含低于 0.5 分数候选的行会显示复核提醒。置信分数不是已校准的正确概率。扩展词表只扩大候选范围，不代表 204 类均已实测可靠。

1. 选择 JPG/JPEG/PNG，最大 10 MiB、20 百万像素。页面显示本地预览。
2. 点击 **Recognize Ingredients**。加载期间控件禁用，失败可重试；成功后用 Start New Photo 开始下一次，避免重新识别覆盖修改。
3. 框和置信度是原始模型输出。列表按模型类别合并；置信度取该类别最高值，数量建议是检测框数量，不代表准确物体数。
4. 修改名称、删除误报、手动补充漏检。名称必须匹配共享食材词典；不会偷偷创建新的字典项。
5. 单位为 `piece` 的食材提供可修改的计数建议；`g`、`ml` 留空，必须人工填写。模型服务把提示词 `milk carton` 映射为词典中的 `milk`，不是把一盒当作 1 ml。
6. 点击 **Confirm and Add to Fridge** 才保存。重复食材在同一批次合并；同一食材已有库存时增加数量。
7. 保存后进入 **My Fridge** 查看真实数据库结果。新库存默认 private，已有库存的 visibility 保持原值。

支持最多 50 行。无检测结果和服务不可用时也能手动添加。更换照片、刷新或退出账号会清理内存中的照片和未保存草稿。照片不会被服务写入磁盘。

## 5. 数据流与 API

```text
浏览器图片文件
  → POST /api/recognition（Node：验证会话、类型、大小）
  → POST http://127.0.0.1:8001/recognize（Python：解码、EXIF 方向、YOLO）
  → JSON：名称、confidence、像素 xyxy 框、原图宽高
  → 浏览器 canvas 与人工编辑草稿
  → POST /api/inventory/imports（确认后的 ingredient_id 和 quantity）
  → MongoDB 事务：inventory_items + inventory_imports
  → GET /api/inventory → My Fridge
```

图片传输采用原始文件 bytes 和 `Content-Type: image/jpeg` / `image/png`，不是 multipart；这避免在原有无框架 Node 服务里新增 multipart 依赖。浏览器不直接跨域访问 Python。

详细请求/响应见 [API 文档](api/photo-recognition.md)。

## 6. 与 Inventory 组员对接

- 唯一库存仍然是 `inventory_items`，没有第二套库存。
- 保持 `{ _id, user_id, ingredient_id, quantity, visibility, created_at, updated_at }` 原字段。
- `quantity` 是默认单位的百分之一整数：2 eggs → 200，200 ml milk → 20000，125 g tomato → 12500。识别接口里的框数不能直接作为 g/ml。
- 新增 `inventory_imports` 只保存用户、批次 UUID、内容哈希和时间。它与库存增量在同一个事务提交；不保存照片或识别历史。没有 TTL，避免旧请求被重放后再次加库存。
- 双击/网络重试必须复用相同 `batch_id` 和 payload。已提交同一批次返回 `replayed: true`；同一个 ID 内容不同返回 409。
- 前端遇到结果不明确的错误会锁住该批次，并提供 **Retry Same Confirmation**；不会自行创建新 ID 再次添加。
- 这是按提交编号的防重复，不是按照片去重：用户开始新批次并再次上传同一照片仍会增加库存。不要用它反复扫描已有库存来“同步总量”。
- Inventory 组员可直接接管 `src/modules/inventory/repository.js`，保留批量添加契约和事务去重逻辑；不必让 Photo Recognition 直接操作数据库。
- 若组员已经另行完成库存路由，合并时可把 `/api/inventory*` 的分发从 recognition 路由移到 inventory 路由，前端 API 不用改变。
- Python 和 Node 共用 `shared/recognition-ingredients.json` 的名称、提示词、类别、单位；seed 只追加不存在的条目，不覆盖原有 UUID 或单位。204 类覆盖常见果蔬、肉蛋海鲜、豆制品、乳制品、谷物面食、坚果、香草和调料，包括白菜、青江菜、莲藕、芋头、三文鱼、虾蟹、米粉和酱油等。请与 Inventory 组员一起审阅默认单位。

## 7. 测试与真实输出

```powershell
npm test
.\.venv\Scripts\python.exe -m pytest services\recognition -q
.\.venv\Scripts\python.exe services\recognition\smoke_test.py C:\path\to\photo.jpg
```

前两项不要求模型服务运行。Node 测试使用独立临时 MongoDB replica set；首次下载如果发生并行缓存锁冲突，等待下载结束后重跑，或用 `node --test --test-concurrency=1`。

第三项是实际 HTTP 推理，需要 Python 服务就绪。支持 `--output .local\result.json` 保存原始结果。测试报告及未完成项目见 [测试记录](photo-recognition-test-report.md)。自动化接口测试中的 stub 明确标注为测试替身，不能用于证明模型识别准确性。

## 8. 文件导航

| 文件 | 用途 |
| --- | --- |
| `public/js/pages/recognition/recognition.js` | 上传预览、框、人工编辑、防重复 UI、只读库存展示 |
| `public/index.html`、`public/styles.css`、`public/app.js` | 页面模板、现有样式补充、导航和文件请求支持 |
| `shared/recognition-ingredients.json`、`.js` | 204 类识别与库存映射的共享清单及 Node 读取模块 |
| `services/recognition/app.py` | FastAPI、校验、内存图片解码、模型加载和推理 |
| `services/recognition/setup_model.py` | 下载官方权重、准备离线词汇模型、验证加载 |
| `services/recognition/requirements.txt` | 核心兼容依赖版本 |
| `services/recognition/requirements-lock-windows.txt` | 本次实测 Windows Python 3.11 完整依赖快照 |
| `services/recognition/smoke_test.py`、`test_app.py` | 真实照片测试工具、服务异常测试 |
| `src/modules/recognition/routes.js` | 已认证图片代理和当前库存适配路由 |
| `src/modules/inventory/repository.js` | 共享库存读取和事务批量添加 |
| `src/modules/auth/routes.js`、`src/app.js` | 复用认证和静态模块入口 |
| `src/db/schema.js`、`database/seeds/ingredients.js` | 去重集合 validator/index、补充食材词典 |
| `tests/integration/recognition.test.js` | HTTP 校验、权限、真实库存事务/并发测试 |
| `tests/database/mongodb.test.js` | 仅更新新增集合/词典数量断言，保留原有测试 |
| `.env.example`、`.gitignore`、README/相关 docs | 本地配置、排除权重/照片、操作与交接说明 |

## 9. 11 月 17 日前建议完成

1. 用小组自己拍的冰箱、桌面食材照片补测演示要使用的类别，记录成功和失败例，尤其鸡蛋、牛奶盒、蔬菜。
2. 与 Inventory 组员确认词典单位和批量添加接口归属，避免并行实现同一路由。
3. 在演示电脑提前运行模型准备脚本、启动三项服务并预演，确保现场不依赖大文件下载。
4. 准备一张识别较好的完整水果照片和一张误识别照片，演示人工纠错；不要把检测框数包装成精确数量。

尚未实现 Receipt Recognition、自训练、重量估计、保质期识别、云部署以及完整个人库存编辑。本次没有评估全部 204 类的准确率，也没有开展生产环境负载或跨平台测试。

模型参考：[Ultralytics YOLO-World 官方文档](https://docs.ultralytics.com/models/yolo-world/)。使用 Large v2 支持自定义词汇、CPU 推理和离线词汇保存。本地真实对照测试决定从 medium 升级到 Large；七张样例不能作为整体准确率结论。
