# 风月为邻

> 把空闲，还给生活。

基于《风月为邻微信小程序需求文档 PRD v1.0》开发的微信原生小程序。项目默认可在无 AppID、无云环境时以本地模式运行；配置 CloudBase 后启用 `hy3`、云数据库、私有照片存储和个人数据云端删除。

## 已实现

- 一分钟首次引导、默认生活板块和行动库；
- “此刻 / 风月 / 足迹”三个主页面与暖色玻璃拟态设计系统；
- 时间、精力、环境、用户确认的位置摘要和自由描述；
- 每次五个候选，`hy3` 失败时自动使用本地规则推荐；
- 多计划、最近关注、想做清单，以及可搜索、编辑、关联计划并直接开始的行动库；
- 计时、暂停、恢复、直接去做和再次打开后的单次追问；
- 足迹完成状态、时长、感受、文字、照片、位置、编辑与删除；
- 周、月、年和自定义回望，AI 失败时生成无评价的基础回顾；
- “问风月”对话历史，AI 行动/计划草稿必须点击确认后才保存；
- 本地优先存储、可选云同步、私有照片和全部个人数据删除。

## 直接运行

1. 用微信开发者工具导入本目录。
2. 未配置 AppID 时保留 `project.config.json` 中的 `touristappid`，先体验本地流程。
3. 真机和云能力接入时，将 `project.config.json` 的 `appid` 换成实际 AppID。

## CloudBase 配置

1. 在 `miniprogram/config/env.js` 填入 `CLOUD_ENV_ID`。
2. 在控制台的 AI → 生文模型中开启 `hy3`。小程序基础库要求 3.15.1 或更高。
3. 部署 `dataManager` 后，首次启动会自动创建 `cloudbase/collections.json` 中缺失的集合。
4. 创建集合不会自动应用权限文件；发布前必须通过部署流程或控制台，将 `cloudbase/database-rule.json` 应用到每个集合，并将 `cloudbase/storage-rule.json` 应用到云存储。
5. 当前项目已开启 `ENABLE_CLOUD_SYNC`；部署 `dataManager` 云函数后可执行完整个人数据删除。

没有环境 ID 时不执行集合创建或云函数部署。拿到环境 ID 后，可先运行：

```bash
/Users/cbim/.codex/skills/wechat-cloudbase-deploy/scripts/deploy-cloudbase.sh \
  --dry-run \
  --project /Users/cbim/game/fy \
  --env cloud1-d6ggbwshu81f83485 \
  --collections user_preferences,life_domains,actions,plans,wishes,footprints,reviews,ai_conversations,ai_usage \
  dataManager
```

再根据 dry-run 结果初始化集合并部署云函数。云函数始终从 `cloud.getWXContext()` 读取调用者身份，不接受客户端伪造的 openid。

## 检查

```bash
npm run check
```

静态检查验证页面文件、JSON 与 JavaScript 语法。真机位置授权、私有照片读取、`hy3` 生成质量及云同步仍需在配置实际 AppID 和环境 ID 后验证。
