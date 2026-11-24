# Codex Chats List 架构

```mermaid
flowchart LR
  UI["VS Code 原生界面<br/>浏览与管理会话"]
  Host["工作区扩展宿主<br/>同步和本地查询"]
  Git["工作区 Git"]
  GitHub["GitHub 仓库元数据"]
  Server["Codex app-server"]
  Codex["官方 Codex 侧栏"]
  Prefs["工作区状态<br/>范围、排序和展开偏好"]
  Index["扩展全局存储<br/>共享会话索引"]
  Preferences["扩展全局存储<br/>项目与会话偏好"]
  Repositories["扩展全局存储<br/>仓库身份缓存"]
  UI <-->|"操作和节点更新"| Host
  Host <-->|"本地 stdio：查询、新建、重命名与删除"| Server
  Host <-->|"列表元数据和同步进度"| Index
  Host <-->|"读写置顶、隐藏和仓库归属"| Preferences
  Git -->|"工作区根目录和已知检出"| Host
  GitHub -->|"仓库 ID 和规范名称"| Host
  Host <-->|"远程地址与仓库身份"| Repositories
  Host <-->|"保存视图偏好"| Prefs
  Host -->|"VS Code 内部窗口 URI"| Codex
```

宿主从本地 app-server 首次逐页同步，再从共享索引按范围、目录或仓库加载树节点。同一存储范围下只有持有租约的窗口回源同步。点开会话时，宿主按 ID 校验该条元数据后跳转到官方侧栏。

查询与视图行为见 [DESIGN.md](DESIGN.md)，存储结构见 [history-schema.md](docs/history-schema.md)。
