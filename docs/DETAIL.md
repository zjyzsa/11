# 技能管理

在会话工具栏的按钮里，打开或停用单个技能，并决定每个技能可以在哪些工作区里
使用。

## 两个控制项

当前工作区能看到的每个技能占一行：一个开关，加一个工作区设置。

- **开关** — 关掉之后，这个技能到处都消失：模型技能清单里没有它，`/` 菜单
  里没有它，`skill` 工具也会报告它不可用。
- **工作区** — 留空表示不限制，任何工作区都能用。填上一个或多个目录后，只有
  会话的工作目录落在其中某个目录下面时，技能才可用。

两个开关叠加生效：被关掉的技能即使在允许的工作区里也保持隐藏。


## 技能是怎么被隐藏的

插件不改写、也不删除任何技能文件。它注册一个优先级更高的提供方，为每个被
压制的技能贡献一个同名候选，并把该候选的
`invocation: { modelInvocable: false, userInvocable: false }`。注册表解析同名
条目时取最近、优先级最高的候选，技能清单和 `/` 手势都会把这个候选过滤掉，
于是真技能变得不可见，而磁盘上的文件原封不动。取消限制后，原技能在下一步
重新出现。

遮蔽要贡献两次，因为技能分两层：宿主注册表里是内置技能和用户技能，而某个
预设的常驻组合（`dsh-doc`、`hindsight-coding-agent` 这些预设技能就是从这里
发现的）是更近的一层，它遇到同名条目会直接获胜。所以插件既注册到
`ctx.skills`，也为每个活着的会话注册到该 Agent 自己的注册表。被限制或停用
的技能因此在两层里都离开清单。

改动在下一步生效，因为工具清单是在那一步重建的。

## 设置存在哪里

`<DSH_HOME>/skill-manager/state.json`，每个技能一条记录：

```json
{
  "version": 1,
  "skills": {
    "office-docx": { "enabled": false, "workspaces": [] },
    "dsh-doc": { "enabled": true, "workspaces": ["C:\\work\\harness"] }
  }
}
```

这个文件按配置共享，所以限制会跟着用户跨会话、跨工作区生效。写入是原子的
（先写临时文件再改名到目标）；解析不了的状态文件会被保留为
`state.json.corrupt-<时间戳>`，而不是被悄悄覆盖。

## 给智能体用的工具

`skill_manager` 工具把同一份清单报告给智能体。改动类动作（`set_enabled`、
`set_workspaces`）默认被拒绝——某个技能要不要隐藏是用户的决定，所以默认只有
面板能改。想让智能体也能改，在插件配置里加 `allowToolMutations: true`：

```yaml
- id: skill-manager
  name: 'dsh-skill-manager'
  config:
    allowToolMutations: true
```

- `list`
- `set_enabled`，参数 `name`、`enabled`
- `set_workspaces`，参数 `name`、`workspaces`（传 `[]` 表示取消限制）

两个改动类动作只接受本配置确实能看到的技能、绝对路径的工作区、真正的布尔值，
并且调用与面板路由完全相同的宿主函数。

## HTTP 接口

面板通过下面这些路由和宿主通信，所以界面能做的事也可以脚本化：

| 路由 | 方法 | 参数 |
| --- | --- | --- |
| `/skill-manager/api/state` | GET | `?session=<id>` 或 `?cwd=<path>` |
| `/skill-manager/api/skills/enabled` | POST | `{ name, enabled }` |
| `/skill-manager/api/skills/workspaces` | POST | `{ name, workspaces }` |


响应都是 JSON，并附带刷新后的清单。不带会话的 `GET /state` 退回默认工作目录。
POST 必须带 `x-skill-manager: 1`，请求体上限 64 KiB。


## 限制

- 技能以名称为身份：在某一层关掉 `foo`，也会遮住项目层里更高优先级的同名
  `foo`。
- 工作区匹配是路径前缀判断：列出的目录本身及其下所有内容，Windows 上不区分
  大小写。相对路径会被直接拒绝，而不是去猜。
- 还没有活 Agent 的会话（冷会话的清单，`/` 菜单能读到的那种）来自插件够不到
  的层，所以预设技能在那里可能仍会出现；会话一旦活起来，限制就生效。
- 状态文件按用户存放，不按配置目录分开；同一个用户同一时间只跑一个宿主进程
  （桌面应用就是这样）。

