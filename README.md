# Skill manager（DeepSeek Harness 插件）

在会话工具栏放一个按钮，用来开关单个技能、把技能限定在指定工作区。
不需要构建、没有运行时依赖，纯 JS 的两个文件（宿主半边 + 浏览器半边）。

## 功能

- **开关**：关掉的技能在模型技能清单、`/` 菜单和 `skill` 工具里同时消失，
  磁盘上的技能文件不动。
- **工作区限制**：留空 = 任何工作区都能用；选一个或多个目录后，只有会话工作
  目录落在其中某个目录下时才可用。
- **实时生效**：新增或删除技能下一次打开面板就能看到，不用重启。
- **给智能体的只读工具** `skill_manager`：能列出清单，默认不能改；需要时在插件
  配置里设 `allowToolMutations: true`。

## 安装

在 DeepSeek Harness 的「插件」页点「添加插件」，填下面任意一种来源：

| 来源 | 填什么 | 前提 |
| --- | --- | --- |
| 本地目录（推荐） | 把本仓库下载成 zip 解压，填解压目录的绝对路径，例如 `D:\code\11` | 无 |
| GitHub | `git+https://github.com/zjyzsa/11.git` | 运行 DSH 的机器上要装有 `git`，否则安装会报 `git ls-remote failed` |
| npm（如果发布过） | `dsh-skill-manager` | 无 |

安装由 DSH 的插件管理器完成，不需要手动改 profile 里的 `package.json` 或
`cordis.patch.yml`。装好之后重载页面（`Ctrl+R`），会话标题右侧就会出现滑块图标；
没出现时再检查「插件」页里这个包是否已启用。

## 使用

1. 打开任意会话，点标题右侧的滑块图标，或把指针停在上面看提示「管理技能」。
2. 每个技能一行：右边开关控制可用性，下面「限定工作区…」展开目录选择。
3. 选择目录会用系统目录对话框；「取消限制」把技能恢复成所有工作区可用。

设置存在 `<DSH_HOME>/skill-manager/state.json`，按用户共享，跨会话生效。

## HTTP 接口

面板与宿主之间用同源 JSON 接口，脚本也能用：

| 路由 | 方法 | 参数 |
| --- | --- | --- |
| `/skill-manager/api/state` | GET | `?session=<id>` 或 `?cwd=<path>` |
| `/skill-manager/api/skills/enabled` | POST | `{ name, enabled }` |
| `/skill-manager/api/skills/workspaces` | POST | `{ name, workspaces }` |

POST 需要 `x-skill-manager: 1` 请求头，请求体上限 64 KiB。

## 实现要点

技能注册表是分层合并的：宿主层放内置和用户技能，每个 Agent 的预设组合是更近
的一层。本插件不改写技能，只注册一个优先级更高的**同名遮蔽项**（
`invocation: { modelInvocable: false, userInvocable: false }`），并同时注册到
`ctx.skills` 和每个活 Agent 的注册表，所以被停用的技能在两层里都消失。

## 目录结构

```
index.js           宿主半边：注册遮蔽提供方、HTTP 路由、skill_manager 工具
client.js          浏览器半边：工具栏按钮 + 面板（React.createElement，无构建）
cordis.patch.yml   安装时插入的配置行
locale/{en,zh}.json 标题与描述
icon.svg           插件图标
docs/DETAIL.md     完整行为说明（中文）
```

## 限制

- 技能以名称为身份：在某一层关掉 `foo`，更高层里的同名 `foo` 也一起被遮住。
- 工作区匹配是路径前缀判断，Windows 上不区分大小写，相对路径会被拒绝。
- 冷会话（还没有活 Agent）的技能清单来自插件够不到的层，激活后限制才生效。

更多细节见 [docs/DETAIL.md](docs/DETAIL.md)。

## 许可

[MIT](LICENSE)
