# 11 月 17 日 Photo Recognition 演示

2026-11-16 已整合 `main` 的 `d6ba1b1`：组员的库存增删改、默认食材图片和共享食材表。识别页面使用 `/api/ingredients` 的 212 个词典项，模型仍有 204 个食材候选；候选数不等于已验证的识别能力。

## 演示图片

本机文件：`D:\FriendsFridge\.local\test-images\presentation-sugar-eggs-apples-bananas.png`。

这是 **AI 生成的演示图，不是真实拍摄的准确率测试集**。画面包含白砂糖（糖袋和糖碗）、8 个鸡蛋、3 个苹果、4 根香蕉。模型确实对图片执行推理，未预填答案。照片和模型权重被 Git 忽略，换电脑时需要单独复制演示图、重新准备模型。

本次实际接口返回：egg 8 个框、apple 3 个框、banana 1 个框、sugar 2 个框。网页按名称合并为四行。糖的两个框分别对应容器，不代表 2 克；克数留空。

## 两分钟演示流程

1. 登录现有账号，查看 My Fridge 的初始数量。新一批确认会增加已有库存，重复演练不要把累加结果当作本次检测数量。
2. 打开 Photo Recognition，选择上述图片，展示预览，点击 **Recognize Ingredients**。
3. 解释框和名称是模型建议。标记 `review` 的名字经过本地视觉复核，仍需确认；糖、盐、面粉的外观很接近。
4. 将 banana 的数量从 **1 改为 4**。模型把香蕉串当成一个框，正好展示人工修正计数。
5. 给 sugar 填写 **500 g**，说明这是用户输入的演示值，不是照片测量结果；真实使用时填写实际称重或包装信息。
6. 如需展示删除和补充，可删除 apple 行，再点击 **+ Add Ingredient**，从共享词典填回 `apple`、数量 `3`。名称也可直接编辑。
7. 点击 **Confirm and Add to Fridge**，再进入 My Fridge。展示鸡蛋、糖、苹果和香蕉进入组员的同一份库存，并可使用已有编辑、共享功能。

可以这样说明设计：“照片识别帮助建立草稿，用户负责核对名称和数量。确认后才写入共享库存；重量不会由图片自动估算。”

## 启动与模型更新

完整首次安装见 [运行指南](photo-recognition.md)。本次升级增加两个容器候选和本地 CLIP 复核，旧版用户需要重新准备模型：

```powershell
cd D:\FriendsFridge
.\.venv\Scripts\python.exe services\recognition\setup_model.py
```

准备成功会生成 `services/recognition/.cache/ingredients-reviewed-worldv2-l.pt`，并保留 `.cache/clip/ViT-B-32.pt`。之后分别在三个终端运行：

```powershell
# 终端 A
npm run db:local
```

```powershell
# 终端 B
.\.venv\Scripts\python.exe -m uvicorn app:app --app-dir services/recognition --host 127.0.0.1 --port 8001
```

```powershell
# 终端 C
npm start
```

打开 <http://127.0.0.1:3000/#recognition>。模型健康检查 <http://127.0.0.1:8001/health> 应显示 `status: ready` 和 `label_review: local-clip`。如果服务已经运行，不要重复启动占用相同端口。

## 真实照片验证与限制

| 样本 | 原 Large 模型 | 加入保守视觉复核后 |
| --- | --- | --- |
| 真实白砂糖碗 | 未检出食材 | sugar 候选 1 个，要求人工确认 |
| 真实 6 个棕色鸡蛋 | 6 个误标 orange | 5 个 egg、1 个仍误标 orange |
| 生成演示图 | egg 7、错误 orange 1、apple 3、banana 1，漏糖 | egg 8、apple 3、banana 1、sugar 2 |

真实糖图：[Sparkveela，A Bowl of Sugar，CC0](https://commons.wikimedia.org/wiki/File:A_Bowl_of_Sugar.jpg)。真实鸡蛋图：[Samsule2，Eggs in a plastic bowl gotten from Noiler Birds 01，CC BY-SA 4.0](https://commons.wikimedia.org/wiki/File:Eggs_in_a_plastic_bowl_gotten_from_Noiler_Birds_01.jpg)，使用 Wikimedia 的 1280px 缩略图，未作其他像素修改。

这些是少量样例上的定向改进，不能推出整体准确率。混合果蔬仍有番茄/甜椒等误标，真实鸡腿肉照片仍漏检。对照了更高分辨率、提示词变体和 Extra Large；它们没有稳定改善本次鸡蛋场景，最终保留 Large、640px，并增加本地裁剪复核。没有新训练，没有外部 AI API，没有运行时 mock 数据。

演示前用自己手机拍的同类食材再预演一次；提前下载权重、启动服务。真实测试结果和其余限制见 [测试记录](photo-recognition-test-report.md)。
