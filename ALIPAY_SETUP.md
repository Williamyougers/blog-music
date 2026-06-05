# 支付宝当面付接入配置指南

> 给威灵T本人看的保姆级流程。代码已经写好了，你只需要照着这份做：申请应用 → 拿密钥 → 配进 Cloudflare → 测试。

---

## 一、申请支付宝应用（你来，1~3 天审核）

### Step 1. 登录支付宝开放平台
打开 https://open.alipay.com/ ，用你**已经做过营业执照实名认证**的支付宝账号登录。

### Step 2. 创建应用
1. 顶部「控制台」→「网页&移动应用」→「创建应用」
2. **应用类型**：选「自研应用」
3. **应用名称**：随便起，比如「威灵T编曲铺子」
4. **应用图标**：上传你站点的 favicon 也行（256×256 PNG）
5. **应用简介**：「独立音乐人接单网站，用于客户在线支付编曲订单」
6. 提交 → 等审核（一般 1~3 个工作日，营业执照齐全的话很快）

### Step 3. 添加能力
应用过审后：
1. 进入这个应用的控制台
2. 左侧「能力管理」→「未签约的能力」
3. 找到「**当面付**」→ 点「签约」
4. 上传营业执照副本，按提示填写信息
5. 等签约审核（通常 1~2 天）

### Step 4. 生成密钥对
1. 应用控制台 → 左侧「开发设置」
2. 找到「接口加签方式」→「设置」
3. **下载支付宝的密钥工具**：https://opendocs.alipay.com/common/02kipl
4. 打开工具：
   - 密钥长度选 **RSA2 (2048)**
   - 密钥格式选 **PKCS1（非 JAVA 适用）**……
   - ⚠️ **等等**！我们 Cloudflare Worker 用的是 Web Crypto API，必须用 **PKCS8** 格式
   - 所以下载完密钥后还需要转一次（见下面 Step 5）
5. 点「生成密钥」
6. 把生成的「**应用公钥**」复制粘进支付宝开放平台的设置框，保存
7. 保存成功后，支付宝会显示一段「**支付宝公钥**」—— **整段复制下来**（很重要，验签要用）

### Step 5. 把应用私钥转成 PKCS8 格式

支付宝默认给的是 PKCS1，但 Cloudflare Worker 的 Web Crypto API 只认 PKCS8。

**方式一**（最简单）：让支付宝官方密钥工具直接生成 PKCS8 格式
- 在密钥工具里，格式选 PKCS8 后再点「生成密钥」即可

**方式二**：用 openssl 转
```bash
# 假设你的私钥文件名是 alipay_rsa_private_key.pem
openssl pkcs8 -topk8 -inform PEM -in alipay_rsa_private_key.pem -outform PEM -nocrypt -out alipay_rsa_private_key_pkcs8.pem
```

---

## 二、把密钥配进 Cloudflare Worker

打开 Windows PowerShell，进入 worker 目录：

```powershell
cd path\to\blog-music\cloudflare-worker
```

逐条执行（每条会让你输入对应的值，**全段粘贴 PEM 整体，包含 `-----BEGIN PRIVATE KEY-----` 和 `-----END PRIVATE KEY-----` 这两行**）：

```powershell
# 1. APP_ID（应用控制台首页能看到的 20 位数字 ID）
npx wrangler secret put ALIPAY_APP_ID

# 2. 应用私钥（PKCS8 格式 PEM，整段贴入）
npx wrangler secret put ALIPAY_PRIVATE_KEY

# 3. 支付宝公钥（在「开发设置」→「接口加签方式」里能复制到，整段贴入）
#    注意：要套上 PEM 头尾，自己拼上：
#    -----BEGIN PUBLIC KEY-----
#    （支付宝给的公钥内容）
#    -----END PUBLIC KEY-----
npx wrangler secret put ALIPAY_PUBLIC_KEY
```

> ⚠️ 支付宝给的「支付宝公钥」可能只有中间一段 base64 字符串，没有 `-----BEGIN PUBLIC KEY-----` 头尾，你需要**自己手动拼上**。

### 可选 secrets（不配就用默认值）
```powershell
# 沙箱测试用（默认是正式环境 openapi.alipay.com）
# 沙箱: https://openapi-sandbox.dl.alipaydev.com/gateway.do
npx wrangler secret put ALIPAY_GATEWAY

# 异步通知 URL（默认 https://api.weilingt.top/api/pay/notify）
# 如果你的 worker 域名不一样，需要改
npx wrangler secret put ALIPAY_NOTIFY_URL
```

---

## 三、验证 secrets 配上了

```powershell
npx wrangler secret list
```

应该看到至少有 `ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` 三条。

---

## 四、测试支付流程

1. 打开 https://weilingt.top
2. 登录你自己（或随便注册一个测试账号）
3. 在工坊提交一单（选 t_dlib 流行编曲 ¥800 或任一固定价套餐）
4. 看到「我的订单」卡片下方有「**💰 立即支付 ¥800**」按钮
5. 点击 → 弹出二维码
6. 用手机支付宝扫一扫 → 付款 1 分钱（先用沙箱环境测；或者你真付 ¥800 给自己测，付完用「撤销付款」+ 退款）
7. 付款成功后弹窗 2 秒后自动关闭，订单变成「✅ 已付款」
8. 你的手机微信（如果配了 Server 酱）应该会收到「💰 收款」推送

---

## 五、常见报错对照表

| 错误 | 原因 | 怎么修 |
|---|---|---|
| `支付未配置` | secrets 没配 | 重新执行 `wrangler secret put` |
| `支付宝下单失败 invalid-app-id` | APP_ID 错了 / 应用未上线 | 检查支付宝应用是否「已上线」状态 |
| `支付宝下单失败 sign-verify-error` | 私钥格式不对 | 确认是 PKCS8 不是 PKCS1 |
| `支付宝下单失败 invalid-method` | 当面付能力没签约 | 回开放平台签约「当面付」 |
| `二维码加载失败` | qrserver.com 临时挂了 | 弹窗里有「点击这里手动打开」链接兜底 |
| 付款后订单不变 | notify_url 不通 / 验签失败 | 看 wrangler tail 日志 |

实时看 worker 日志：
```powershell
npx wrangler tail
```

---

## 六、手续费 & 到账

- **费率**：0.6%（每笔自动扣，到账金额 = 订单金额 × 99.4%）
- **到账周期**：T+1（第二个工作日到你绑的银行卡）
- **单日单笔**：5w，对个人小微够用了

---

## 七、安全提醒

- ❌ **不要**把私钥 PEM 文件提交到 Git 仓库
- ❌ **不要**把私钥贴在聊天框 / 公开文档里
- ✅ 私钥只在 Cloudflare Wrangler Secrets 里
- ✅ 备份一份私钥到你自己的本地加密压缩包（万一密钥工具的本地缓存丢了找不回）

---

完事，有问题截图发我。
