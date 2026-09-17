# pi-zh-slash

中文输入法下用顿号「、」打 Pi 命令，不必切到英文再敲 `/`。

`、设置` → `/settings`，补全列表显示「设置（settings）」。

这不是界面汉化。已有 [`@muzi3/type-easier`](https://www.npmjs.com/package/@muzi3/type-easier) 把「、」当成「/」去补英文命令名；本包加上中文别名、IME 整块上屏、空格定形和回车兜底。不要和 `type-easier` 同时安装。

## 安装

```bash
pi install npm:pi-zh-slash
```

或：

```bash
pi install git:github.com/youxia-2025/pi-zh-slash
```

装完 `/reload` 或新开会话。

## 用法

行首输入顿号：

```text
、设置          →  /settings
、模型 sonnet   →  /model sonnet
、名            →  /name     （「命名」比「自动命名」更短，不会误中）
```

- 补全列表显示「中文（英文）」
- `、名` 后按空格会立刻变成 `/name `，随后参数候选与原生 `/` 相同
- 输入法一次性上屏「、设置」也会弹出补全
- 列表未开直接回车时，整句 `、名 参数` 会改写成 `/name 参数`
- skill 命令保持英文，不造中文别名

已有别的扩展接管了编辑器时，本包只包装补全、不再换编辑器（空格定形 / IME 兜底会弱一些，顿号补全仍可用）。

## 自定义别名

编辑 `~/.pi/agent/pi-zh-slash.aliases.json`，只追加、不覆盖内置表：

```json
{
  "web-tools": ["联网", "搜索"]
}
```

改完 `/reload`。例子见仓库里的 `aliases.example.json`。

## 内置别名

| 命令 | 中文 |
|---|---|
| settings | 设置 |
| model | 模型 |
| tree | 会话树、树 |
| thinking | 思考 |
| scoped-models | 模型范围 |
| export / import / share / copy | 导出 / 导入 / 分享 / 复制 |
| name | 命名 |
| session | 会话 |
| changelog | 更新日志 |
| hotkeys | 快捷键、热键 |
| fork / clone | 分叉 / 克隆 |
| trust | 信任 |
| login / logout | 登录 / 登出 |
| new | 新会话、新建 |
| compact | 压缩 |
| resume | 恢复 |
| reload | 重载、刷新 |
| quit | 退出 |
| clear | 清空、清除 |
| exit | 退出程序、结束 |
| outline | 大纲 |
| usage | 用量、额度、余额 |

后四条是常见社区扩展；没装对应扩展时不会出现在补全里。

## 开发

```bash
npm test
```

本地试跑：

```bash
pi -e ./extensions/index.ts
```
