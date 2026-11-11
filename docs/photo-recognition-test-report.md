# Photo Recognition 测试记录

## 最新结果：204 类 + YOLO-World Large

2026-11-11：已移除页面上的类别说明区；共享词表扩展到 204 类，库存词典补齐 206 项。默认模型为官方 `yolov8l-worldv2.pt`，保存的离线词汇模型 `ingredients-worldv2-l.pt` 约 94.5 MB。CPU，640px，conf=0.45，IoU=0.5，class-agnostic NMS。未训练模型，也没有模拟识别结果。

同批照片对比发现：204 类 medium 会增加误报；Large 在混合果蔬图中恢复了葡萄检测，并按用户要求切换到 Large；逐框核对仍发现甜椒和番茄互相错标，因此没有证据宣称整体准确率提高。更大模型仍不是全品类可靠识别的保证。类别是提示词候选，不能当作已验证识别能力。

推荐复现图为 `.local/test-images/02-mixed-produce.jpg`，来自 [National Cancer Institute 的真实果蔬照片](https://commons.wikimedia.org/wiki/File:Fruit_and_vegetables_basket.jpg)，public domain，未改动原图。最终在线实测得到 grapes 0.869、orange 0.6507、apple 0.6198、bell pepper 0.5743、tomato 0.4836；逐框核对：grapes 和 orange 位置合理；apple 对应桃子的误判；bell pepper 框实际是番茄、tomato 框实际是下方红椒；梨和玉米等漏检。结果不是事先填入页面的数据。

七张真实照片通过已认证 Node 接口测试，原始输出保存在 `.local/recognition-tests/final-204-class-http.json`。五张原测试照片外新增的紫色花椰菜篮和辣椒篮也存在明显误报：不作为成功示例宣传。鸡肉图仍没有检出。中型模型对照在 `medium-204-class-http.json`，Large 阈值 0.35 的初步对照在 `large-204-evaluation.json`。

扩展后 Node 全项目 17 项测试通过，Python 3 项测试通过；实际 HTTP 验证了词典映射、错误媒体类型、空文件、损坏图片、空白图及识别前后库存不变。新增类别仍需更多独立照片评估，不报告未经测量的整体准确率。

## 历史结果：2026-11-11，65 类 prototype

当前运行版本为官方 `yolov8m-worldv2.pt` + `shared/recognition-ingredients.json` 的 65 类离线词汇，未训练。准备后的权重约 57.2 MB，文件为 `ingredients-worldv2-m.pt`。下方 11 月 10 日的十类/小模型记录保留为历史对照，不代表当前配置。

- 共用清单覆盖 18 类水果、26 类蔬菜、9 类蛋/肉/海鲜/豆制品、4 类乳制品、4 类主食、4 类豆类坚果。数据库共 71 个词典条目，已有 UUID/单位保持不变。
- 同五张原图比较 small 与 medium；medium 能检出黄瓜，并避免该鸡肉图中的 carrot 误报，选为本地默认。仍有漏检、误报，不能推导全部类别准确率。
- 参数：CPU，640px，conf=0.35，IoU=0.5，class-agnostic NMS，最多 50 框。低于 0.5 的候选会在列表中提醒复核；不自动入库。
- 官方说明参考：[Ultralytics YOLO-World](https://docs.ultralytics.com/models/yolo-world/)。本次仍使用已安装验证的 Ultralytics 8.3.228，没有升级 Python 依赖。

通过已认证的 Node `POST /api/recognition` 访问真实 Python 模型，五次均 HTTP 200、`source: model`：

| 真实照片 | 最终输出（框数） | 单次 HTTP 耗时 | 人工核对与限制 |
| --- | --- | --- | --- |
| 01-apples-bananas.jpg | apple ×5、banana ×1、orange ×1 | 1.205 s | 苹果和香蕉检出；仍有错误橙子，成串香蕉不可据框数精确计数 |
| 02-mixed-produce.jpg | apple ×4、orange ×1、sweet potato ×1、grapes ×1 | 0.836 s | 橙子、葡萄检出；存在把其他果蔬错标 apple/sweet potato 的情况，未完整检出所有食材 |
| 03-whole-vegetables.jpg | carrot ×15、cucumber ×3、potato ×2 | 0.734 s | 黄瓜和胡萝卜检出；大蒜仍被误判成土豆，葱漏检 |
| 04-chicken-thighs.jpg | 无检测 | 0.586 s | 鸡肉已加入词表，但此图仍未检出；不能宣称鸡肉识别通过 |
| 05-carrot-basket.jpg | carrot ×6 | 0.522 s | 本图不再有 tomato/corn/bell pepper 误报，但重叠胡萝卜仍有漏检 |

时间为本机单次实测，不是性能基准。原始结果为 `.local/recognition-tests/final-65-class-http.json`；模型对照结果为同目录的 `baseline-evaluation.json`、`expanded-s-evaluation.json`、`expanded-m-evaluation.json`、`broad-m-evaluation.json`。这些都被 Git 忽略，不是运行时预设答案。

验证范围：

1. Node 全项目测试：17 项通过，包含新类别入库/重试、库存事务、登录、好友、消息、食材请求、食谱权限及原有页面。
2. Python 服务测试：3 项通过，覆盖图片格式/空文件/尺寸、EXIF、模型不可用/失败/忙碌/空结果。仅自动化错误分支测试使用明确标注的 stub。
3. 实际 HTTP：65 个识别名全部可映射到库存；空文件/损坏图片/错误媒体类型被拒绝；白色 PNG 返回空检测；五张照片的纯识别测试前后库存不变。
4. 实际网页：展开 65 类清单；上传 03 原图并预览；点击识别后显示 20 框；把 potato 改成 garlic、删除 carrot 行、手动补 green onion、填写数量后确认。
5. `photo_demo` 账号实际新增 cucumber 125 g、garlic 50 g、green onion 25 g。这些是人工输入的测试数量，非模型估重。确认后按钮禁用；进入 My Fridge 并刷新后数据仍在，原有 banana/orange 保留。
6. 网页证据：`.local/recognition-tests/expanded-inventory-browser.png`。源码语法检查和 `git diff --check` 通过。

所有应用识别结果和库存均为真实服务输出/数据库写入，没有运行时 mock。65 类是候选范围，本次只有上述五张真实食材照片；肉类、包装食品、奶制品和其余未测类别需要更多照片验证。11 月 17 日前应在演示电脑和小组自拍照片上再预演，演示中保留纠错环节。

## 历史记录：2026-11-10

日期：2026-11-10。本地 Windows，Python 3.11.10，Node.js 24.19.0，Ultralytics 8.3.228，PyTorch 2.15.0+cpu，torchvision 0.29.2+cpu。模型：官方 `yolov8s-worldv2.pt` + 十类自定义词汇，没有训练。

## 自动化测试

- `npm test`：16 个测试通过，0 失败。包括原有账号/好友/消息/请求/食谱回归，以及新增上传代理验证、实际 MongoDB 库存事务、三次并发同一批次只入库一次、重复行合并、用户隔离、非法数量与整批回滚。
- Python `pytest services/recognition -q`：3 个测试通过。包括格式/空文件/伪造类型/超限、模型不可用/失败/忙碌/空列表、EXIF 旋转。
- Node 的识别上游 fixture 与 Python 的 stub 仅用于验证协议/异常处理，均在测试代码中明确标注，不代表真实模型识别。
- 首次 MongoDB 并行下载发生过缓存锁竞争；下载后重新执行全部通过。受限执行环境无法访问本机服务的情况通过正常授权后重跑；不是代码测试通过的替代证据。

## 实际模型推理

所有下列结果来自运行中的 FastAPI 服务和实际 YOLO 模型，阈值 0.25，CPU。时间是单次本地 HTTP 调用耗时，不是性能基准或准确率评估。

| 输入 | 真实结果 | 判断 |
| --- | --- | --- |
| [OpenCV fruits.jpg](https://github.com/opencv/opencv/blob/4.x/samples/data/fruits.jpg)，512×480 水果切片近照 | egg 0.5442、egg 0.3013、apple 0.2751，约 0.66 秒 | 明显误识别；切片橙子/柠檬不能视作鸡蛋。保留为失败案例 |
| [Apples and bananas in bowl](https://commons.wikimedia.org/wiki/File:Apples_and_bananas_in_bowl.jpg)，3072×2304 | 10 个框：7 apple、1 banana、2 orange；apple 最高 0.9095、banana 0.7696，精简模型重测约 0.64 秒 | 多个苹果和香蕉正确；橙子为误报，存在低分重复框和遮挡，框数不能当作真实数量 |
| 本地生成的 640×480 纯白 PNG（明确为合成负样本） | `detections: []`，约 0.53 秒 | 成功验证真实模型的无检测结果路径；不是实物照片准确性证据 |

第二张照片作者 Dj Galaxy，来源页声明 public domain。下载的测试原图仅保存在被 Git 忽略的 `.local/recognition-tests/`，没有把公开照片或用户照片打包进网站。

本机证据：`.local/recognition-tests/fruits-result.json`、`fruit-bowl-result.json`、`blank-result.json`。它们是测试产物，不是应用运行时数据，也不会提交到 Git。

## 浏览器实际操作

使用本地 `photo_demo` 测试账号、真实 Node + MongoDB + Python 服务完成：

1. 登录、导航到新增 Photo Recognition。
2. 上传真实 JPG、显示 canvas 预览、点击识别、显示加载状态和模型检测结果。
3. 删除错误 apple 行，将 egg 改为 orange，并将数量改为 0.5。
4. 手动补充 banana，数量 1。
5. 点击确认后按钮禁用；My Fridge 显示 banana 1 piece 和 orange 0.5 pieces。
6. 刷新页面，保存的数据仍然存在。
7. 新的完整水果照片上传后展示 10 个原始检测框、类别和置信度。该第二批仅作为待确认草稿展示，没有自动入库。
8. 浏览器未记录 JavaScript error，窄窗口下表单和导航可用。

继续交付检查时重新启动了本地服务：Web/MongoDB health 正常，模型 health 为 ready；通过测试账号 API 确认 banana=100、orange=50（百分之一单位）仍保留，证明数据跨服务重启持久化。重启后的空白图片实际推理仍返回空列表。

截图：`.local/recognition-tests/inventory-browser.jpg`、`recognition-browser.jpg`。

## 没有声称通过的项目

- 后续五图测试补充了 carrot 和 tomato 的真实照片；仍未用对应实物照片逐一验证 potato/broccoli/onion/egg/milk carton，不能承诺十类可靠识别。
- 冰箱内部、弱光、遮挡、不同包装尚未做系统评估。
- 没有逐项在浏览器文件选择器里测试非法文件、20MP 超限、空结果和断网；相关服务端异常路径已通过自动化测试，空白 PNG 也经过实际推理。
- 未做 CUDA、macOS/Linux、手机实机、长时间高并发与生产部署测试。
- 原有功能通过现有回归测试，不等于逐页人工测试整个项目。
- 个人库存完整编辑/删除/共享设置、Receipt Recognition 均未实现。

结论：Prototype 核心闭环可实际运行；识别准确性仍需要更多真实样本和人工确认，不能作为最终成品准确率声明。

## 后续：用户指定的五张照片测试

通过网页实际使用的已认证 `POST /api/recognition` 依次发送五张照片。五次均 HTTP 200，`source: model`；耗时约 0.30–0.71 秒。测试前后读取 photo_demo 库存并比较，完全一致；没有调用确认入库接口。

以下数量均为模型检测框数，不是真实食材数量：

| 照片 | 当前十类配置的真实输出 | 人工核对 |
| --- | --- | --- |
| 01-apples-bananas.jpg | apple ×7、banana ×1、orange ×2 | 多个苹果和香蕉正确；橙子为误报，苹果有重复框，香蕉成串不可按一个框当一根 |
| 02-mixed-produce.jpg | apple ×4、orange ×1、tomato ×2 | 橙子与其中一个番茄框合理；桃/油桃、甜椒被错标，番茄同时出现 apple/tomato 重叠框；玉米、梨、葡萄等不在原词表 |
| 03-whole-vegetables.jpg | carrot ×15、potato ×3 | 胡萝卜被检出；大蒜/蒜瓣被标为土豆（最高 0.5816）；黄瓜、蒜、葱未配置为类别 |
| 04-chicken-thighs.jpg | carrot ×1，0.5334 | 完全误报，图中是生鸡肉；原词表没有鸡肉 |
| 05-carrot-basket.jpg | carrot ×12、tomato ×1 | 多个胡萝卜正确；番茄误报，遮挡使计数不可靠 |

原始 JSON：`.local/test-images/results/all-results.json`，各图也有独立 JSON。脚本 `.local/test-images/run_batch_test.py` 使用本地测试账号，不提交库存。

### 为什么会这样

1. 本次应用词表按初始要求配置了十类。YOLO-World 能接收新文本类别，但当前请求不会自动生成任意食材名称。没配置的类别可能被忽略，也可能被错分为已配置类别，并不是一定返回“未知”。
2. 阈值为 0.25，保留了较多低分候选；默认按类别分别做重复框抑制，所以同一物体可能同时出现不同标签。
3. small 预训练模型没有在本项目真实冰箱/食材照片上训练或校准。相似外观、遮挡、成串对象和包装会影响结果。置信分数不是对本项目验证过的正确概率。
4. 前端目前展示所有达到阈值的候选，并按类别合并；缺少候选范围说明和明显的低置信提醒，容易让用户把它当作最终判定。

### 临时扩展词表对照实验（未上线）

用同一官方基础权重分别运行原始十类和十九类词表。新增 `cucumber, garlic, green onion, corn, grapes, pear, bell pepper, peach, raw chicken meat`；其他参数不变：CPU、640px、conf=0.25、IoU=0.5。没有训练，没有修改当前服务的权重或 CLASSES。

结果：混合果蔬图开始出现 bell pepper（最高 0.6399）、grapes（0.2995）；蔬菜图出现 cucumber（最高 0.8927）。但鸡肉仍只产生错误 carrot，蒜/葱未可靠检出，且蔬菜图和胡萝卜篮新增了 bell pepper 误报。因此“扩展类别”有必要但不足以保证准确性。

扩展实验原始结果：`.local/test-images/results/vocabulary-comparison.json`。实验使用未重新保存为半精度的基础权重，因此原始十类分数与在线准备模型存在小差异；判断扩展效果时比较的是该实验内部的两组。仅五张挑选的照片，不能视作泛化准确率评估。

### 门槛不能一刀切

对当前在线输出按 >=0.50 再筛选：水果图的两个错误橙子会被去掉，但鸡肉的错误 carrot=0.5334 仍保留；混合果蔬图的正确 tomato=0.4317 被去掉，最后只剩两个错误 apple。因此不把提高门槛当作通用修复。

建议下一轮：逐类增加并验证常见食材和库存映射；用更多实拍样本比较提示词及更大 YOLO-World 模型；再决定重复框策略和门槛。保留人工确认，不把本次扩展实验直接部署到当前网页。
