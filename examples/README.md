# examples/

这里放的是**独立的诊断脚本**，不属于 MCP 服务器本体，也不参与 `npm test`。
排查问题时用来把「桥接层」和「服务商」分开定位。

| 脚本 | 用途 |
|---|---|
| `direct-ocr.js` | 绕过 MCP，直接打视觉 API 做一次 OCR。用来判断问题在桥接层还是服务商 |
| `gemini-native-ocr.js` | 直接调 Gemini 原生 `generateContent` 端点（关掉思考模式），验证长 OCR 不被截断 |
| `deepseek-vision-probe.js` | 实测 DeepSeek 官方 API 是否真的支持图片输入（结论：不支持，这也是本项目存在的原因） |

日常验证优先用服务器自带的 CLI，不用这些脚本：

```bash
node server.js --doctor                                # 看生效配置
node server.js --ping                                  # 用内置生成的测试图真调一次 API
node server.js --call ocr_image --image D:/shot.png    # 直接跑一次 OCR
```
